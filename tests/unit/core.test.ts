import { describe, expect, it } from 'vitest';
import { authenticateOwner, checkOrigin, requireRead } from '../../src/lib/server/core/auth';
import { equalDigest, sha256, stableId } from '../../src/lib/server/core/crypto';
import { normalizeRecipient, readBounded } from '../../src/lib/server/core/storage';
import type { RuntimeEnv } from '../../src/lib/server/core/types';

const env = {
  OWNER_EMAIL:'CHANGE_ME', ACCESS_TEAM_DOMAIN:'https://CHANGE_ME.cloudflareaccess.com',ACCESS_AUD:'CHANGE_ME',
  CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com'
} as RuntimeEnv;

describe('native email input boundaries', () => {
  it('normalizes only addresses in the configured mail domain', () => {
    expect(normalizeRecipient('Research@Agent.Example.com','agent.example.com')).toBe('research@agent.example.com');
    for (const value of ['a@other.com','a@agent.example.com.attacker.com','a@@agent.example.com','.a@agent.example.com','a..b@agent.example.com','a\r\n@agent.example.com']) {
      expect(normalizeRecipient(value,'agent.example.com')).toBeNull();
    }
  });
  it('enforces actual stream size and cancels oversized input', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}});
    await expect(readBounded(stream as never,5)).rejects.toMatchObject({code:'message_too_large'});
    expect(cancelled).toBe(true);
    const bytes = await readBounded(new Response('hello').body as never,5);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });
});

describe('authentication boundaries', () => {
  it('does not accept owner claims when Access is unconfigured', async () => {
    const request = new Request('https://console.example.com/owner/api/setup/checks',{
      headers:{'X-Owner':'true','Cf-Access-Authenticated-User-Email':'owner@example.com'}
    });
    await expect(authenticateOwner(request as never,env)).rejects.toMatchObject({code:'owner_not_configured'});
  });
  it('requires a JWT assertion when configured and ignores identity headers', async () => {
    await expect(authenticateOwner(new Request('https://console.example.com/owner',{
      headers:{'Cf-Access-Authenticated-User-Email':'owner@example.com'}
    }) as never,{...env,OWNER_EMAIL:'owner@example.com',ACCESS_TEAM_DOMAIN:'https://agent-mail.cloudflareaccess.com',ACCESS_AUD:'test-aud'}))
      .rejects.toMatchObject({code:'unauthorized'});
  });
  it('requires the console Origin for Owner writes and denies foreign bearer Origins', () => {
    expect(()=>checkOrigin(new Request('https://console.example.com/owner',{method:'POST'}) as never,env,true)).toThrow('forbidden_origin');
    expect(()=>checkOrigin(new Request('https://api.example.com/v1/messages',{headers:{Origin:'https://evil.example'}}) as never,env,false)).toThrow('forbidden_origin');
    expect(()=>checkOrigin(new Request('https://api.example.com/v1/messages') as never,env,false)).not.toThrow();
    expect(()=>requireRead({kind:'token',mailboxId:'a',tokenId:'t',canRead:false})).toThrow('insufficient_scope');
  });
});

it('hashes secrets and derives stable, namespaced UUIDs',async()=>{
  expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(await stableId('body:a')).toMatch(/^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(await stableId('body:a')).toBe(await stableId('body:a'));
  expect(await stableId('body:a')).not.toBe(await stableId('body:b'));
  expect(equalDigest('a'.repeat(64),'a'.repeat(64))).toBe(true);
  expect(equalDigest('a'.repeat(64),'a'.repeat(63)+'b')).toBe(false);
});
