import { requireRead } from '#lib/server/core/auth.ts';
import {listMessages,messageQuery} from '#lib/server/core/mail.ts';
import { api } from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async ({locals,url}) => {
  const actor = requireRead(locals.actor);
  return Response.json(await listMessages(ownerContext(locals),actor.mailboxId,messageQuery(url.searchParams)));
});
