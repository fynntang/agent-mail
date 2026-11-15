import { ServiceError } from './types';

export async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ServiceError('message_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

export function normalizeRecipient(address: string, domain: string): string | null {
  const value = address.toLowerCase();
  if (value.length > 254 || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]{1,64}@[a-z0-9.-]+$/.test(value)) return null;
  const [local, host] = value.split('@');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || host !== domain.toLowerCase()) return null;
  return value;
}
