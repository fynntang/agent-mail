import {expect,it} from 'vitest';
import {cloudflareSuppressionConfig} from '../../src/lib/server/core/cloudflare-suppression-config';
import {cloudflareSendGuard,knownCloudflareSuppressedAddresses} from '../../src/lib/server/core/cloudflare-suppression-policy';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

const secret='worker-only-suppression-management-token',config={EMAIL_SUPPRESSIONS_ACCOUNT_ID:'A'.repeat(32),EMAIL_SUPPRESSIONS_DOMAIN:'send.example.com',EMAIL_SUPPRESSIONS_API_TOKEN:secret} as RuntimeEnv;
it('exposes only explicit account/domain identity and never returns the Worker secret',()=>{
  expect(cloudflareSuppressionConfig(config)).toEqual({accountId:'a'.repeat(32),domain:'send.example.com'});
  expect(JSON.stringify(cloudflareSuppressionConfig(config))).not.toContain(secret);
});
it('disables management for missing values, malformed domains and unsafe authorization bytes',()=>{
  for(const patch of [{EMAIL_SUPPRESSIONS_ACCOUNT_ID:''},{EMAIL_SUPPRESSIONS_ACCOUNT_ID:'../other'},{EMAIL_SUPPRESSIONS_DOMAIN:'SEND.example.com'},
    {EMAIL_SUPPRESSIONS_DOMAIN:'send.example.com/'},{EMAIL_SUPPRESSIONS_DOMAIN:'send..example.com'},{EMAIL_SUPPRESSIONS_DOMAIN:'localhost'},
    {EMAIL_SUPPRESSIONS_API_TOKEN:''},{EMAIL_SUPPRESSIONS_API_TOKEN:'short'},{EMAIL_SUPPRESSIONS_API_TOKEN:secret+'\r\nX-Forged: true'},
    {EMAIL_SUPPRESSIONS_API_TOKEN:'x'.repeat(4097)}])expect(cloudflareSuppressionConfig({...config,...patch})).toBeNull();
});
it('leaves an unconfigured installation idle and builds only bound fixed-origin policy SQL',async()=>{
  const disabled={...config,EMAIL_SUPPRESSIONS_API_TOKEN:'',DB:{prepare(){throw new Error('must stay idle');}}} as unknown as RuntimeEnv;
  expect(cloudflareSendGuard(disabled,'mailbox',['x@example.net'])).toEqual({sql:'1=1',args:[]});
  expect(await knownCloudflareSuppressedAddresses(disabled,'mailbox',['x@example.net'])).toEqual(new Set());
  const address="o'brien@example.net",guard=cloudflareSendGuard(config,'mailbox',[address]);
  expect(guard.sql).not.toContain(address);expect(guard.sql).not.toContain(secret);expect(guard.args).toContain(JSON.stringify([address]));
  expect(guard.args).not.toContain(secret);expect(guard.sql).toContain('a.is_primary=1');expect(guard.sql).toContain('c.scope_type');
});
