import {error,fail} from '@sveltejs/kit';
import {listOAuthGrants,revokeOAuthGrant,OAuthError} from '#lib/server/core/oauth.ts';
import {readBounded} from '#lib/server/core/storage.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type {Actions,PageServerLoad} from './$types';

export const load:PageServerLoad=async({locals})=>{
  try {return {grants:await listOAuthGrants(ownerContext(locals))};}
  catch(cause) {
    if(cause instanceof ServiceError||cause instanceof OAuthError) error(cause.status,{message:'无法读取 MCP 授权，请稍后重试。'});
    throw cause;
  }
};

export const actions:Actions={
  revoke:async({locals,request})=>{
    try {
      if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/x-www-form-urlencoded'||!request.body) throw new ServiceError('invalid_input',400);
      const fields=new URLSearchParams(new TextDecoder().decode(await readBounded(request.body,4096)));
      if([...fields.keys()].some(key=>key!=='grantId')||fields.getAll('grantId').length!==1) throw new ServiceError('invalid_input',400);
      await revokeOAuthGrant(ownerContext(locals),fields.get('grantId')??'');
      return {success:'授权已撤销，此客户端的新请求和刷新将被拒绝。'};
    }catch(cause) {
      if(cause instanceof ServiceError||cause instanceof OAuthError) return fail(cause.status,{error:'无法撤销此授权，请刷新列表后重试。'});
      throw cause;
    }
  }
};
