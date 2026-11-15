import type {RequestHandler} from '@sveltejs/kit';
import {approveDraft,cancelOutbound,discardDraft,getDraft,listDrafts,listOutbound,requestSend,saveDraft} from '../core/outbound';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

type Operation='drafts.list'|'drafts.create'|'draft.get'|'draft.update'|'draft.discard'|'draft.approve'|'draft.send'|'outbound.list'|'outbound.cancel';
export function outboundApi(operation:Operation,owner:boolean):RequestHandler {
  return api(async({locals,params,request})=>{
    const ctx=ownerContext(locals);
    if(owner&&ctx.actor?.kind!=='owner') throw new ServiceError('owner_required',403);
    if(!owner&&ctx.actor?.kind!=='token') throw new ServiceError('unauthorized',401);
    const box=owner?params.id!:ctx.actor?.kind==='token'?ctx.actor.mailboxId:'';
    const draft=params.draftId!,outbound=params.outboundId!;
    switch(operation) {
      case 'drafts.list': return Response.json({drafts:await listDrafts(ctx,box)});
      case 'drafts.create': return Response.json({draft:await saveDraft(ctx,box,await jsonInput(request,256*1024))},{status:201});
      case 'draft.get': return Response.json({draft:await getDraft(ctx,box,draft)});
      case 'draft.update': return Response.json({draft:await saveDraft(ctx,box,await jsonInput(request,256*1024),draft)});
      case 'draft.discard': await discardDraft(ctx,box,draft);return new Response(null,{status:204});
      case 'draft.approve': return Response.json({draft:await approveDraft(ctx,box,draft,await jsonInput(request))});
      case 'draft.send': return Response.json(await requestSend(ctx,box,draft,await jsonInput(request),request.headers.get('Idempotency-Key')),{status:202});
      case 'outbound.list': return Response.json({outbound:await listOutbound(ctx,box)});
      case 'outbound.cancel': await jsonInput(request);await cancelOutbound(ctx,box,outbound);return new Response(null,{status:204});
    }
  });
}
