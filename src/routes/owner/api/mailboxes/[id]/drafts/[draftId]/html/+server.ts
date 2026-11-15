import {previewDraftHtml} from '#lib/server/core/outbound-html.ts';
import {mailHtmlCsp,renderMailHtmlDocument} from '#lib/server/core/mail-html.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {api} from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params,url})=>{
  const entries=[...url.searchParams];
  const version=url.searchParams.get('expectedVersion')??'',hash=url.searchParams.get('contentSha256')??'';
  if(entries.length!==2||entries.some(([key])=>!['expectedVersion','contentSha256'].includes(key))
    ||!/^\d{1,10}$/.test(version)||Number(version)<1||!/^[0-9a-f]{64}$/.test(hash))throw new ServiceError('invalid_query',400);
  const result=await previewDraftHtml(ownerContext(locals),params.id!,params.draftId!,Number(version),hash);
  const allowImages=result.loadedInlineImages>0;
  return new Response(renderMailHtmlDocument(result,{allowImages}),{headers:{'Content-Type':'text/html; charset=utf-8',
    'Cache-Control':'private, no-store','Content-Security-Policy':mailHtmlCsp(allowImages),'X-Frame-Options':'SAMEORIGIN',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'}});
});
