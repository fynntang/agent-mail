const API_ORIGIN = 'https://api.cloudflare.com';
const API_BASE = `${API_ORIGIN}/client/v4`;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;

/** Errors deliberately exclude provider messages, request URLs, and credentials. */
export class CloudflareError extends Error {
  constructor(code, operation, { status, apiCodes = [] } = {}) {
    const details = [status ? `HTTP ${status}` : '', apiCodes.length ? `API codes ${apiCodes.join(',')}` : ''].filter(Boolean);
    super(`${operation} failed${details.length ? ` (${details.join('; ')})` : ''}`);
    this.name = 'CloudflareError';
    this.code = code;
    this.operation = operation;
    if (status !== undefined) this.status = status;
    this.apiCodes = apiCodes;
  }
}

function fail(code, operation, details) {
  throw new CloudflareError(code, operation, details);
}

function nameValue(value, operation) {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || value.length > 256 || CONTROL.test(value)) {
    fail('cloudflare_invalid_input', operation);
  }
  return value;
}

function uuidValue(value, operation, code = 'cloudflare_invalid_response') {
  if (typeof value !== 'string' || !UUID.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) fail(code, operation);
  return value.toLowerCase();
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNatural = value => Number.isSafeInteger(value) && value >= 0;

function responseName(value, operation) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || CONTROL.test(value)) {
    fail('cloudflare_invalid_response', operation);
  }
  return value;
}

function d1Record(result, operation) {
  if (!isObject(result)) fail('cloudflare_invalid_response', operation);
  return { id: uuidValue(result.uuid, operation), name: responseName(result.name, operation) };
}

function r2Record(result, operation) {
  if (!isObject(result)) fail('cloudflare_invalid_response', operation);
  return { name: responseName(result.name, operation) };
}

async function boundedJson(response, operation) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    fail('cloudflare_response_too_large', operation);
  }
  if (!response.body) fail('cloudflare_invalid_response', operation);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        fail('cloudflare_response_too_large', operation);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('cloudflare_invalid_response', operation);
  }
}

/** Local/CI control-plane client; it never reads environment variables or retries requests. */
export class CloudflareClient {
  #token;
  #accountId;
  #fetch;

  constructor({ token, accountId, fetchFn = fetch } = {}) {
    const operation = 'Cloudflare client configuration';
    if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(accountId) || /^0{32}$/.test(accountId)) {
      fail('cloudflare_invalid_input', operation);
    }
    if (typeof token !== 'string' || !token.trim() || token !== token.trim() || CONTROL.test(token) || token.length > 8192 || typeof fetchFn !== 'function') {
      fail('cloudflare_invalid_input', operation);
    }
    this.#token = token;
    this.#accountId = accountId.toLowerCase();
    this.#fetch = fetchFn;
  }

  async #request(operation, method, parts, { query, body, notFound = false } = {}) {
    // Every path component is encoded, and callers cannot supply a URL or origin.
    const url = new URL(`${API_BASE}/accounts/${this.#accountId}/${parts.map(part => encodeURIComponent(part)).join('/')}`);
    if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await this.#fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        redirect: 'error',
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && new URL(response.url).origin !== API_ORIGIN)) {
        await response.body?.cancel().catch(() => {});
        fail('cloudflare_redirect_rejected', operation, { status: response.status });
      }
      if (notFound && response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const envelope = await boundedJson(response, operation);
      if (!isObject(envelope) || typeof envelope.success !== 'boolean') fail('cloudflare_invalid_response', operation, { status: response.status });
      const apiCodes = Array.isArray(envelope.errors)
        ? envelope.errors.map(error => error?.code).filter(code => Number.isSafeInteger(code) && code >= 0).slice(0, 16)
        : [];
      if (!response.ok || !envelope.success) fail('cloudflare_api_error', operation, { status: response.status, apiCodes });
      return envelope;
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      fail(controller.signal.aborted ? 'cloudflare_timeout' : 'cloudflare_network_error', operation);
    } finally {
      clearTimeout(timeout);
    }
  }

  async findD1(name) {
    const operation = 'D1 lookup';
    nameValue(name, operation);
    let match = null;
    let processed = 0;
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      // D1's total_count describes the whole account, even when `name` filters results.
      // Scan unfiltered pages so short pages and totals cannot make an existing target
      // appear absent (or reject a valid lookup) in accounts with other databases.
      const envelope = await this.#request(operation, 'GET', ['d1', 'database'], { query: { page, per_page: 100 } });
      if (!Array.isArray(envelope.result)) fail('cloudflare_invalid_response', operation);
      for (const result of envelope.result) {
        const record = d1Record(result, operation);
        if (record.name === name) {
          if (match) fail('cloudflare_ambiguous_resource', operation);
          match = record;
        }
        if (seen.has(record.id)) fail('cloudflare_invalid_pagination', operation);
        seen.add(record.id);
      }
      processed += envelope.result.length;
      const info = envelope.result_info;
      if (info !== undefined && !isObject(info)) fail('cloudflare_invalid_pagination', operation);
      if (info?.page !== undefined && info.page !== page) fail('cloudflare_invalid_pagination', operation);
      if (info?.count !== undefined && info.count !== envelope.result.length) fail('cloudflare_invalid_pagination', operation);
      const perPage = info?.per_page ?? 100;
      if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 10_000 || envelope.result.length > perPage) fail('cloudflare_invalid_pagination', operation);
      if (info?.total_count !== undefined && (!isNatural(info.total_count) || info.total_count < processed)) fail('cloudflare_invalid_pagination', operation);
      const more = info?.total_count !== undefined ? page * perPage < info.total_count : envelope.result.length === perPage;
      if (!more) {
        if (info?.total_count !== undefined && processed !== info.total_count) fail('cloudflare_invalid_pagination', operation);
        return match;
      }
      if (envelope.result.length !== perPage) fail('cloudflare_invalid_pagination', operation);
    }
    fail('cloudflare_pagination_limit', operation);
  }

  async createD1(name) {
    const operation = 'D1 creation';
    nameValue(name, operation);
    const envelope = await this.#request(operation, 'POST', ['d1', 'database'], { body: { name } });
    const record = d1Record(envelope.result, operation);
    if (record.name !== name) fail('cloudflare_invalid_response', operation);
    return record;
  }

  async getD1(id) {
    const operation = 'D1 verification';
    id = uuidValue(id, operation, 'cloudflare_invalid_input');
    const envelope = await this.#request(operation, 'GET', ['d1', 'database', id], { notFound: true });
    if (!envelope) return null;
    const record = d1Record(envelope.result, operation);
    if (record.id !== id) fail('cloudflare_invalid_response', operation);
    return record;
  }

  async findR2(name) {
    const operation = 'R2 lookup';
    nameValue(name, operation);
    let match = null;
    let cursor;
    const cursors = new Set();
    const names = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const envelope = await this.#request(operation, 'GET', ['r2', 'buckets'], { query: { name_contains: name, per_page: 1000, cursor } });
      if (!isObject(envelope.result) || !Array.isArray(envelope.result.buckets)) fail('cloudflare_invalid_response', operation);
      for (const result of envelope.result.buckets) {
        const record = r2Record(result, operation);
        if (record.name === name) {
          if (match) fail('cloudflare_ambiguous_resource', operation);
          match = record;
        }
        if (names.has(record.name)) fail('cloudflare_invalid_pagination', operation);
        names.add(record.name);
      }
      if (envelope.result_info !== undefined && !isObject(envelope.result_info)) fail('cloudflare_invalid_pagination', operation);
      const next = envelope.result_info?.cursor;
      if (next === undefined || next === null || next === '') return match;
      if (typeof next !== 'string' || next.length > 4096 || CONTROL.test(next) || cursors.has(next)) fail('cloudflare_invalid_pagination', operation);
      cursors.add(next);
      cursor = next;
    }
    fail('cloudflare_pagination_limit', operation);
  }

  async createR2(name) {
    const operation = 'R2 creation';
    nameValue(name, operation);
    const envelope = await this.#request(operation, 'POST', ['r2', 'buckets'], { body: { name } });
    const record = r2Record(envelope.result, operation);
    if (record.name !== name) fail('cloudflare_invalid_response', operation);
    return record;
  }

  async getR2(name) {
    const operation = 'R2 verification';
    nameValue(name, operation);
    const envelope = await this.#request(operation, 'GET', ['r2', 'buckets', name], { notFound: true });
    if (!envelope) return null;
    const record = r2Record(envelope.result, operation);
    if (record.name !== name) fail('cloudflare_invalid_response', operation);
    return record;
  }

  async workerExists(name) {
    const operation = 'Worker verification';
    nameValue(name, operation);
    const envelope = await this.#request(operation, 'GET', ['workers', 'scripts', name, 'settings'], { notFound: true });
    if (!envelope) return false;
    if (!isObject(envelope.result)) fail('cloudflare_invalid_response', operation);
    return true;
  }

  async workersSubdomain() {
    const operation = 'Workers subdomain lookup';
    const envelope = await this.#request(operation, 'GET', ['workers', 'subdomain']);
    const subdomain = envelope.result?.subdomain;
    if (typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) fail('cloudflare_invalid_response', operation);
    return subdomain;
  }
}
