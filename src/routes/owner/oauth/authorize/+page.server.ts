import {error,fail,redirect} from '@sveltejs/kit';
import {createAuthorizationRequest,decideAuthorization,OAuthError} from '#lib/server/core/oauth.ts';
import {readBounded} from '#lib/server/core/storage.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type {Actions,PageServerLoad} from './$types';

function publicStatus(value:number):number {return value>=400&&value<=599?value:500;}

export const load:PageServerLoad=async({locals,url})=>{
  try {return {authorization:await createAuthorizationRequest(ownerContext(locals),url.searchParams)};}
  catch(cause) {
    if(cause instanceof OAuthError&&cause.redirectUrl) redirect(303,cause.redirectUrl,{external:[new URL(cause.redirectUrl).origin]});
    if(cause instanceof ServiceError||cause instanceof OAuthError) {
      error(publicStatus(cause.status),{message:'授权请求无效或已过期。请回到客户端重新发起连接。'});
    }
    throw cause;
  }
};

export const actions:Actions={
  default:async({locals,request})=>{
    let location:string;
    try {
      if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/x-www-form-urlencoded'||!request.body) throw new ServiceError('invalid_input',400);
      const fields=new URLSearchParams(new TextDecoder().decode(await readBounded(request.body,16*1024)));
      const allowed=['requestId','csrfToken','decision','mailboxId','scope','directSending'];
      if([...fields.keys()].some(key=>!allowed.includes(key))||allowed.filter(key=>key!=='scope').some(key=>fields.getAll(key).length>1)) throw new ServiceError('invalid_input',400);
      const decision=fields.get('decision');
      if(decision!=='allow'&&decision!=='deny') throw new ServiceError('invalid_input',400);
      const direct=fields.get('directSending');
      if(direct!==null&&direct!=='1') throw new ServiceError('invalid_input',400);
      const result=await decideAuthorization(ownerContext(locals),{
        requestId:fields.get('requestId')??'',csrfToken:fields.get('csrfToken')??'',decision,
        mailboxId:fields.get('mailboxId')??undefined,scopes:fields.getAll('scope'),requiresApproval:direct!=='1'
      });
      location=result.redirectUrl;
    }catch(cause) {
      if(cause instanceof ServiceError||cause instanceof OAuthError) {
        return fail(publicStatus(cause.status),{error:'授权未完成。请检查邮箱、权限及授权有效期，必要时从客户端重新连接。'});
      }
      throw cause;
    }
    // Keep this outside the catch: SvelteKit redirects are control flow, not OAuth failures.
    redirect(303,location,{external:[new URL(location).origin]});
  }
};
