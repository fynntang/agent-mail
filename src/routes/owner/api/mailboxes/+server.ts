import { createMailbox, listMailboxes } from '#lib/server/core/owner.ts';
import { api } from '#lib/server/svelte/api.ts';
import { jsonInput, ownerContext } from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals})=>Response.json({mailboxes:await listMailboxes(ownerContext(locals))}));
export const POST=api(async({locals,request})=>{
  const mailbox=await createMailbox(ownerContext(locals),await jsonInput(request));
  return Response.json({mailbox},{status:201,headers:{Location:`/owner/mailboxes/${mailbox.id}`}});
});
