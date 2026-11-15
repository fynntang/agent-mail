import {cloudflareSuppressionConfig} from './cloudflare-suppression-config';
import type {RuntimeEnv} from './types';

/** c is a fixed cache-table alias. Match the actual sending domain, never the recipient domain. */
function activePredicate(env:RuntimeEnv,box:string,addresses:string[]):{sql:string;args:(string|number)[]}|null {
  const config=cloudflareSuppressionConfig(env);if(!config)return null;
  return {sql:`c.account_id=? AND c.configured_domain=? AND c.status='active' AND(c.expires_at IS NULL OR c.expires_at>?)
    AND c.address IN(SELECT value FROM json_each(?)) AND(c.scope_type='account' OR(c.scope_type='sending_domain' AND c.scope_value=?))
    AND EXISTS(SELECT 1 FROM mailbox_addresses a WHERE a.mailbox_id=? AND a.is_primary=1 AND a.status='active'
      AND substr(a.address,instr(a.address,'@')+1)=?)`,
    args:[config.accountId,config.domain,Date.now(),JSON.stringify(addresses),config.domain,box,config.domain]};
}
/** SQL is evaluated inside each immutable-send transaction as well as the friendly preflight check. */
export function cloudflareSendGuard(env:RuntimeEnv,box:string,addresses:string[]):{sql:string;args:(string|number)[]} {
  const predicate=activePredicate(env,box,addresses);
  return predicate?{sql:`NOT EXISTS(SELECT 1 FROM cloudflare_suppression_cache c WHERE ${predicate.sql})`,args:predicate.args}:{sql:'1=1',args:[]};
}
export async function knownCloudflareSuppressedAddresses(env:RuntimeEnv,box:string,addresses:string[]):Promise<Set<string>> {
  const predicate=activePredicate(env,box,addresses);if(!predicate||!addresses.length)return new Set();
  const {results}=await env.DB.prepare(`SELECT DISTINCT c.address FROM cloudflare_suppression_cache c WHERE ${predicate.sql}`).bind(...predicate.args).all<{address:string}>();
  return new Set(results.map(row=>row.address));
}
