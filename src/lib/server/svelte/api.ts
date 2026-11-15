import type { RequestHandler } from '@sveltejs/kit';
import { ServiceError } from '../core/types';

/** SvelteKit consumes endpoint exceptions before they reach hooks.handle's catch. */
export function api(handler: RequestHandler): RequestHandler {
  return async event => {
    try { return await handler(event); }
    catch (error) {
      const code=error instanceof ServiceError ? error.code:'internal_error';
      const status=error instanceof ServiceError ? error.status:500;
      if(status>=500) console.error(JSON.stringify({code,requestId:event.locals.requestId}));
      return Response.json({error:{code},requestId:event.locals.requestId},{status,
        headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
  };
}
