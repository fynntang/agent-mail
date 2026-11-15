import { env } from 'cloudflare:workers';
import { authenticateMailbox, authenticateOwner, checkOrigin } from '#lib/server/core/auth.ts';
import { ServiceError, type RuntimeEnv } from '#lib/server/core/types.ts';
import { ownerAuthPage } from '#lib/server/svelte/auth-response.ts';
import {handlePublicOAuth,checkMcpOrigin,validOAuthOrigin,oauthChallenge,addMcpCors} from '#lib/server/core/oauth-http.ts';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = crypto.randomUUID();
  event.locals.actor = null;
  const bindings = env as unknown as RuntimeEnv;
  const path = event.url.pathname;
  // Route IDs are normalized by SvelteKit; encoded path segments must not skip authentication.
  const route=event.route.id??'';
  const owner = [path,route].some(value=>value==='/owner'||value.startsWith('/owner/'));
  const ownerApi=[path,route].some(value=>value==='/owner/api'||value.startsWith('/owner/api/'));
  const mailbox = [path,route].some(value=>value==='/v1'||value.startsWith('/v1/')||value==='/mcp');
  const mcp=[path,route].includes('/mcp');
  try {
    let response=await handlePublicOAuth(event.request,bindings,event.locals.requestId);
    if(!response&&mcp) {
      if(!validOAuthOrigin(event.request.headers.get('Origin'))) throw new ServiceError('forbidden_origin',403);
      event.locals.actor=await authenticateMailbox(event.request,bindings,{allowOAuth:true});
      await checkMcpOrigin(event.request,bindings,event.locals.actor);
    } else if (!response&&(owner || mailbox)) {
      checkOrigin(event.request,bindings,owner);
      event.locals.actor = owner ? await authenticateOwner(event.request,bindings) : await authenticateMailbox(event.request,bindings);
    }
    response??=await resolve(event);
    response.headers.set('X-Request-Id',event.locals.requestId);
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.set('Referrer-Policy','no-referrer');
    // Native Owner forms need a same-origin Origin header. Cross-origin OAuth callbacks still get no Referer.
    if(owner&&['/owner/oauth/authorize','/owner/oauth/grants'].includes(path)&&response.headers.get('Content-Type')?.includes('text/html')) {
      response.headers.set('Referrer-Policy','same-origin');
    }
    if (owner || mailbox) response.headers.set('Cache-Control','private, no-store');
    if(mcp) addMcpCors(response,event.request);
    if(owner) {
      if(!response.headers.has('X-Frame-Options'))response.headers.set('X-Frame-Options','DENY');
      if(!response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy',"frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    }
    return response;
  } catch (error) {
    const code = error instanceof ServiceError ? error.code : 'internal_error';
    const status = error instanceof ServiceError ? error.status : 500;
    // Log only stable diagnostic codes, never tokens, MIME content or raw provider errors.
    if (status >= 500) console.error(JSON.stringify({code,requestId:event.locals.requestId}));
    if(owner && !ownerApi && event.request.headers.get('accept')?.includes('text/html')
      && ['unauthorized','owner_not_configured','forbidden_origin'].includes(code)) {
      return ownerAuthPage(code,status,event.locals.requestId);
    }
    const response=Response.json({error:{code},requestId:event.locals.requestId},{status,
      headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Request-Id':event.locals.requestId,
        ...(mcp && status===401?{'WWW-Authenticate':oauthChallenge(bindings)}:{})}});
    if(mcp) addMcpCors(response,event.request);
    return response;
  }
};

export const handleError: HandleServerError = ({event,kind}) => {
  if(kind!=='unknown') return;
  console.error(JSON.stringify({code:'internal_error',requestId:event.locals.requestId}));
  return {message:'Internal server error'};
};
