import { env } from 'cloudflare:workers';
import type { OwnerContext } from '../core/owner';
import { readBounded } from '../core/storage';
import { ServiceError, type RuntimeEnv } from '../core/types';

/** Builds request context only; each core service independently enforces its required actor. */
export function ownerContext(locals:App.Locals):OwnerContext {
  return {env:env as unknown as RuntimeEnv,actor:locals.actor,requestId:locals.requestId};
}

export async function jsonInput(request:Request,maxBytes=16*1024):Promise<unknown> {
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') throw new ServiceError('json_required',415);
  if(!request.body) throw new ServiceError('invalid_json',400);
  let raw:Uint8Array;
  try { raw=await readBounded(request.body,maxBytes); }
  catch { throw new ServiceError('request_too_large',413); }
  try { return JSON.parse(new TextDecoder().decode(raw)); }
  catch { throw new ServiceError('invalid_json',400); }
}
