import {getMessage,setMessageRead} from '#lib/server/core/mail.ts';
import {api} from '#lib/server/svelte/api.ts';
import {jsonInput,ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params})=>Response.json(await getMessage(ownerContext(locals),params.id!,params.messageId!)));
export const PATCH=api(async({locals,params,request})=>Response.json({message:await setMessageRead(ownerContext(locals),params.id!,params.messageId!,await jsonInput(request))}));
