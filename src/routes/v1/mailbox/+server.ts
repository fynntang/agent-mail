import { env } from 'cloudflare:workers';
import { requireRead } from '#lib/server/core/auth.ts';
import { capabilities, type RuntimeEnv } from '#lib/server/core/types.ts';
import { api } from '#lib/server/svelte/api.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async ({locals}) => {
  const actor = requireRead(locals.actor);
  const {DB,EMAIL} = env as unknown as RuntimeEnv;
  const mailbox = await DB.prepare('SELECT id,name,status FROM mailboxes WHERE id=?').bind(actor.mailboxId).first();
  const addresses = await DB.prepare(`SELECT address,is_primary FROM mailbox_addresses
    WHERE mailbox_id=? AND status='active' ORDER BY is_primary DESC,address`).bind(actor.mailboxId).all();
  return Response.json({mailbox,addresses:addresses.results,permissions:{canRead:actor.canRead,canReadAttachments:actor.canReadAttachments===true,
    canDraft:actor.canDraft===true,canSend:actor.canSend===true,requiresApproval:actor.requiresApproval!==false},
    capabilities:{...capabilities,outboundEmail:Boolean(EMAIL)}});
});
