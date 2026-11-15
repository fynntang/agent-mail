import {cloudflareSuppressionIdentity} from './cloudflare-suppression-config';
import {requireOwner,type OwnerContext} from './owner';

/** Count global incidents once, even when they are visible in multiple mailboxes. No Cloudflare requests. */
export async function suppressionAlertNotice(ctx:OwnerContext):Promise<{count:number;mailboxId:string}|null>{
  requireOwner(ctx.actor);const config=cloudflareSuppressionIdentity(ctx.env);if(!config)return null;
  const row=await ctx.env.DB.prepare(`WITH visible AS(
    SELECT s.id,s.last_occurred_at,(SELECT m.id FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id
      WHERE m.status IN('active','paused') AND a.is_primary=1 AND a.status='active'
        AND substr(a.address,instr(a.address,'@')+1)=s.domain AND(s.global_scope=1 OR m.id=s.mailbox_id)
      ORDER BY m.created_at,m.id LIMIT 1) mailbox_id
    FROM cloudflare_suppression_alerts s WHERE s.account_id=? AND s.domain=? AND s.status='open')
    SELECT COUNT(*) count,(SELECT mailbox_id FROM visible WHERE mailbox_id IS NOT NULL ORDER BY last_occurred_at DESC,id DESC LIMIT 1) mailboxId
    FROM visible WHERE mailbox_id IS NOT NULL`).bind(config.accountId,config.domain).first<{count:number;mailboxId:string|null}>();
  return row&&row.count>0&&row.mailboxId?{count:row.count,mailboxId:row.mailboxId}:null;
}
