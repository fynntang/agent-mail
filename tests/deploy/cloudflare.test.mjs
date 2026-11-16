import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudflareClient, CloudflareError } from '../../scripts/deploy/cloudflare.mjs';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'test-secret-that-must-not-appear-in-errors';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const json = (result, extra = {}, status = 200) => new Response(JSON.stringify({ success: true, result, ...extra }), { status, headers: { 'Content-Type': 'application/json' } });
const database = (name = 'agent-mail', uuid = ID) => ({ uuid, name, ignored: TOKEN });
const bucket = (name = 'agent-mail') => ({ name, ignored: TOKEN });

function harness(responses) {
  const calls = [];
  const client = new CloudflareClient({ token: TOKEN, accountId: ACCOUNT, fetchFn: async (url, init) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    assert.ok(response, 'Unexpected extra HTTP request');
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url, init) : response;
  } });
  return { client, calls };
}

function hasCode(code) {
  return error => {
    assert.ok(error instanceof CloudflareError);
    assert.equal(error.code, code);
    assert.ok(!String(error).includes(TOKEN));
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    return true;
  };
}

test('constructor rejects missing credentials, zero or invalid accounts, and header controls', () => {
  for (const accountId of ['', '0'.repeat(32), 'g'.repeat(32), `${ACCOUNT}/..`, undefined]) {
    assert.throws(() => new CloudflareClient({ token: TOKEN, accountId }), hasCode('cloudflare_invalid_input'));
  }
  for (const token of ['', ' ', '\r\nsecret', 'secret\x00', 'secret\x7f', ' secret', undefined]) {
    assert.throws(() => new CloudflareClient({ token, accountId: ACCOUNT }), hasCode('cloudflare_invalid_input'));
  }
  assert.throws(() => new CloudflareClient({ token: TOKEN, accountId: ACCOUNT, fetchFn: null }), hasCode('cloudflare_invalid_input'));
});

test('creates D1 and R2 with minimal exact JSON payloads, fixed origin, bearer authorization, and no redirects', async () => {
  const { client, calls } = harness([json(database()), json(bucket())]);
  assert.deepEqual(await client.createD1('agent-mail'), { id: ID, name: 'agent-mail' });
  assert.deepEqual(await client.createR2('agent-mail'), { name: 'agent-mail' });
  assert.deepEqual(calls.map(call => call.url), [`${base}/d1/database`, `${base}/r2/buckets`]);
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { name: 'agent-mail' });
    assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  }
});

test('D1 follows page metadata, filters exact names, and returns only safe identifiers', async () => {
  const { client, calls } = harness([
    json([database('agent-mail-archive', OTHER_ID), database('archive-agent-mail', THIRD_ID)], { result_info: { page: 1, per_page: 2, count: 2, total_count: 3 } }),
    json([database()], { result_info: { page: 2, per_page: 2, count: 1, total_count: 3 } })
  ]);
  assert.deepEqual(await client.findD1('agent-mail'), { id: ID, name: 'agent-mail' });
  for (let i = 0; i < calls.length; i++) {
    const url = new URL(calls[i].url);
    assert.equal(url.pathname, `/client/v4/accounts/${ACCOUNT}/d1/database`);
    assert.equal(url.searchParams.has('name'), false);
    assert.equal(url.searchParams.get('page'), String(i + 1));
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(calls[i].init.method, 'GET');
    assert.equal(calls[i].init.body, undefined);
  }
});

test('D1 looks up existing targets among account databases without mixing filtered results and unfiltered totals', async () => {
  const calls = [];
  const client = new CloudflareClient({ token: TOKEN, accountId: ACCOUNT, fetchFn: async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.method, 'GET', 'A lookup must never create a replacement database');
    // Actual API semantics: name filtering narrows result/count, but total_count still
    // counts the entire account. Such a filtered short page is not missing data.
    const filtered = new URL(url).searchParams.has('name');
    return json(filtered ? [database()] : [database('unrelated', OTHER_ID), database(), database('agent-mail-archive', THIRD_ID)],
      { result_info: { page: 1, per_page: 100, count: filtered ? 1 : 3, total_count: 3 } });
  } });
  assert.deepEqual(await client.findD1('agent-mail'), { id: ID, name: 'agent-mail' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.has('name'), false);
});

test('D1 searches the full account through the last page before concluding an exact name is absent', async () => {
  const { client, calls } = harness([
    json([database('agent-mail-archive', OTHER_ID), database('archive-agent-mail', THIRD_ID)], { result_info: { page: 1, per_page: 2, count: 2, total_count: 3 } }),
    json([database('unrelated')], { result_info: { page: 2, per_page: 2, count: 1, total_count: 3 } })
  ]);
  assert.equal(await client.findD1('agent-mail'), null);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(new URL(call.url).searchParams.has('name'), false);
});

test('D1 does not return a partial match or stop after first exact result', async () => {
  const missing = harness([json([database('agent-mail-extra')], { result_info: { page: 1, per_page: 100, total_count: 1 } })]);
  assert.equal(await missing.client.findD1('agent-mail'), null);
  const duplicates = harness([
    json([database()], { result_info: { page: 1, per_page: 1, total_count: 2 } }),
    json([database('agent-mail', OTHER_ID)], { result_info: { page: 2, per_page: 1, total_count: 2 } })
  ]);
  await assert.rejects(duplicates.client.findD1('agent-mail'), hasCode('cloudflare_ambiguous_resource'));
  assert.equal(duplicates.calls.length, 2);
});

test('D1 rejects repeated pages, invalid metadata, and incomplete metadata claims', async () => {
  const cases = [
    [json([], { result_info: { page: 2 } })],
    [json([], { result_info: { per_page: 0 } })],
    [json([], { result_info: { total_count: '1' } })],
    [json([], { result_info: { count: 1 } })],
    [json([database('other')], { result_info: { per_page: 1, total_count: 0 } })],
    [json([], { result_info: { total_count: 1 } })],
    [json([database('other')], { result_info: { per_page: 100, total_count: 2 } })],
    [json([database('other')], { result_info: { per_page: 1, total_count: 2 } }), json([database('other')], { result_info: { page: 2, per_page: 1, total_count: 2 } })]
  ];
  for (const responses of cases) await assert.rejects(harness(responses).client.findD1('agent-mail'), hasCode('cloudflare_invalid_pagination'));
});

test('R2 follows opaque cursor metadata, encodes the cursor, and matches names exactly', async () => {
  const cursor = 'opaque+/= &cursor';
  const { client, calls } = harness([
    json({ buckets: [bucket('agent-mail-extra')] }, { result_info: { cursor } }),
    json({ buckets: [bucket()] }, { result_info: { cursor: '' } })
  ]);
  assert.deepEqual(await client.findR2('agent-mail'), { name: 'agent-mail' });
  const first = new URL(calls[0].url), second = new URL(calls[1].url);
  assert.equal(first.searchParams.get('name_contains'), 'agent-mail');
  assert.equal(first.searchParams.get('per_page'), '1000');
  assert.equal(first.searchParams.has('cursor'), false);
  assert.equal(second.searchParams.get('cursor'), cursor);
});

test('R2 returns null for substring matches and rejects exact duplicates across pages', async () => {
  assert.equal(await harness([json({ buckets: [bucket('agent-mail-extra')] })]).client.findR2('agent-mail'), null);
  const { client, calls } = harness([
    json({ buckets: [bucket()] }, { result_info: { cursor: 'next' } }),
    json({ buckets: [bucket()] })
  ]);
  await assert.rejects(client.findR2('agent-mail'), hasCode('cloudflare_ambiguous_resource'));
  assert.equal(calls.length, 2);
});

test('R2 rejects cursor loops, invalid cursors, and repeated nonmatching buckets', async () => {
  const cases = [
    [json({ buckets: [] }, { result_info: { cursor: 12 } })],
    [json({ buckets: [] }, { result_info: { cursor: '\n' } })],
    [json({ buckets: [] }, { result_info: { cursor: 'x'.repeat(4097) } })],
    [json({ buckets: [] }, { result_info: [] })],
    [json({ buckets: [] }, { result_info: { cursor: 'loop' } }), json({ buckets: [] }, { result_info: { cursor: 'loop' } })],
    [json({ buckets: [bucket('other')] }, { result_info: { cursor: 'next' } }), json({ buckets: [bucket('other')] })]
  ];
  for (const responses of cases) await assert.rejects(harness(responses).client.findR2('agent-mail'), hasCode('cloudflare_invalid_pagination'));
});

test('pagination terminates after 100 pages for each resource', async () => {
  const r2 = harness(Array.from({ length: 100 }, (_, i) => json({ buckets: [] }, { result_info: { cursor: `page-${i}` } })));
  await assert.rejects(r2.client.findR2('agent-mail'), hasCode('cloudflare_pagination_limit'));
  assert.equal(r2.calls.length, 100);
  const d1 = harness(Array.from({ length: 100 }, (_, i) => json([database('other', `${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`)], { result_info: { page: i + 1, per_page: 1, total_count: 101 } })));
  await assert.rejects(d1.client.findD1('agent-mail'), hasCode('cloudflare_pagination_limit'));
  assert.equal(d1.calls.length, 100);
});

test('existing resources are verified by identifier/name and unknown fields are discarded', async () => {
  const { client, calls } = harness([json(database()), json(bucket()), json({ bindings: [], secret: TOKEN }), json({ subdomain: 'my-agents', ignored: TOKEN })]);
  assert.deepEqual(await client.getD1(ID.toUpperCase()), { id: ID, name: 'agent-mail' });
  assert.deepEqual(await client.getR2('agent-mail'), { name: 'agent-mail' });
  assert.equal(await client.workerExists('agent-mail'), true);
  assert.equal(await client.workersSubdomain(), 'my-agents');
  assert.deepEqual(calls.map(call => call.url), [`${base}/d1/database/${ID}`, `${base}/r2/buckets/agent-mail`, `${base}/workers/scripts/agent-mail/settings`, `${base}/workers/subdomain`]);
});

test('resource path components are encoded and cannot replace the fixed API origin', async () => {
  const name = 'https://other.example/name ?#';
  const { client, calls } = harness([json(bucket(name)), json({ bindings: [] })]);
  assert.deepEqual(await client.getR2(name), { name });
  assert.equal(await client.workerExists(name), true);
  assert.equal(calls[0].url, `${base}/r2/buckets/${encodeURIComponent(name)}`);
  assert.equal(calls[1].url, `${base}/workers/scripts/${encodeURIComponent(name)}/settings`);
  assert.equal(new URL(calls[0].url).origin, 'https://api.cloudflare.com');
  for (const input of ['.', '..', '\n']) {
    await assert.rejects(client.getR2(input), hasCode('cloudflare_invalid_input'));
  }
  assert.equal(calls.length, 2);
});

test('get and worker existence alone treat HTTP 404 as not found', async () => {
  const missing = () => new Response('not-found body need not be parsed', { status: 404 });
  const { client } = harness([missing(), missing(), missing()]);
  assert.equal(await client.getD1(ID), null);
  assert.equal(await client.getR2('agent-mail'), null);
  assert.equal(await client.workerExists('agent-mail'), false);
  const listing = harness([json(null, { success: false }, 404)]);
  await assert.rejects(listing.client.findR2('agent-mail'), hasCode('cloudflare_api_error'));
});

test('HTTP and Cloudflare success flags must both succeed; provider error text is never exposed', async () => {
  for (const response of [
    json(null, { success: false, errors: [{ code: 7502, message: TOKEN }, { code: TOKEN, message: TOKEN }] }),
    json(null, { success: true, errors: [{ code: 10000, message: TOKEN }] }, 403)
  ]) {
    const { client, calls } = harness([response]);
    await assert.rejects(client.createD1('agent-mail'), error => {
      hasCode('cloudflare_api_error')(error);
      assert.ok([200, 403].includes(error.status));
      assert.ok(error.apiCodes.every(code => typeof code === 'number'));
      assert.ok(!error.stack.includes(TOKEN));
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('ambiguous POST outcomes never retry and never expose network error text', async () => {
  for (const method of ['createD1', 'createR2']) {
    const { client, calls } = harness([new Error(`request may have succeeded: ${TOKEN}`)]);
    await assert.rejects(client[method]('agent-mail'), hasCode('cloudflare_network_error'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
  }
});

test('requests abort at 20 seconds and expose only a sanitized timeout error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let calls = 0;
  const client = new CloudflareClient({ token: TOKEN, accountId: ACCOUNT, fetchFn: (_url, init) => {
    calls++;
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true }));
  } });
  const pending = client.createD1('agent-mail');
  t.mock.timers.tick(19_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, hasCode('cloudflare_timeout'));
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('HTTP redirects and already-followed redirects are rejected without retry', async () => {
  const redirect = new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
  const followed = json(database());
  Object.defineProperty(followed, 'redirected', { value: true });
  const foreign = json(database());
  Object.defineProperty(foreign, 'url', { value: 'https://other.example/result' });
  for (const response of [redirect, followed, foreign]) {
    const { client, calls } = harness([response]);
    await assert.rejects(client.createD1('agent-mail'), hasCode('cloudflare_redirect_rejected'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'error');
  }
});

test('malformed envelopes, wrong resource identities, and unsafe returned values are rejected', async () => {
  const cases = [
    ['createD1', 'agent-mail', new Response(TOKEN)],
    ['createD1', 'agent-mail', new Response(JSON.stringify({ result: database() }))],
    ['createD1', 'agent-mail', json(database('wrong-name'))],
    ['createD1', 'agent-mail', json(database('agent-mail', 'not-a-uuid'))],
    ['createD1', 'agent-mail', json(database('agent-mail', '00000000-0000-0000-0000-000000000000'))],
    ['getD1', ID, json(database('agent-mail', OTHER_ID))],
    ['getD1', ID, json(database('\n'))],
    ['createR2', 'agent-mail', json(bucket('wrong-name'))],
    ['getR2', 'agent-mail', json(bucket('wrong-name'))],
    ['findD1', 'agent-mail', json({ databases: [] })],
    ['findR2', 'agent-mail', json({ buckets: 'wrong' })],
    ['workerExists', 'agent-mail', json(null)]
  ];
  for (const [method, input, response] of cases) await assert.rejects(harness([response]).client[method](input), hasCode('cloudflare_invalid_response'));
  for (const subdomain of ['', '-bad', 'bad-', 'evil.example/path', TOKEN.toUpperCase(), 'a'.repeat(64)]) {
    await assert.rejects(harness([json({ subdomain })]).client.workersSubdomain(), hasCode('cloudflare_invalid_response'));
  }
});

test('limits response bodies by declared size and streamed bytes before parsing', async () => {
  const declared = new Response('tiny', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } });
  const streamed = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(1024 * 1024));
    controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    controller.close();
  } }));
  for (const response of [declared, streamed]) {
    const { client, calls } = harness([response]);
    await assert.rejects(client.createR2('agent-mail'), hasCode('cloudflare_response_too_large'));
    assert.equal(calls.length, 1);
  }
});
