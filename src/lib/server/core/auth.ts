import { createRemoteJWKSet, jwtVerify } from 'jose';
import { equalDigest, sha256 } from './crypto';
import { ServiceError, type Actor, type RuntimeEnv } from './types';
import {authenticateOAuthAccess} from './oauth-tokens';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateOwner(request: Request, env: RuntimeEnv): Promise<Actor> {
  let issuer: URL;
  try { issuer = new URL(env.ACCESS_TEAM_DOMAIN); }
  catch { throw new ServiceError('owner_not_configured', 503); }
  if (issuer.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname)
    || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash
    || issuer.pathname !== '/' || /CHANGE_ME/i.test(env.ACCESS_TEAM_DOMAIN)
    || !env.ACCESS_AUD || /CHANGE_ME/i.test(env.ACCESS_AUD)
    || !env.OWNER_EMAIL?.includes('@') || /CHANGE_ME/i.test(env.OWNER_EMAIL)) {
    throw new ServiceError('owner_not_configured', 503);
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16384) throw new ServiceError('unauthorized', 401);
  const origin = issuer.origin;
  let keys = keySets.get(origin);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', origin));
    keySets.set(origin, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: origin, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims:['exp','email']
    });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
      throw new Error('wrong_owner');
    }
    return { kind: 'owner', email: payload.email };
  } catch { throw new ServiceError('unauthorized', 401); }
}

/** Format: am_<UUID>_<32 random bytes encoded as base64url>. Never accept mailbox IDs from callers. */
export async function authenticateMailbox(request: Request, env: RuntimeEnv,options:{allowOAuth?:boolean}={}): Promise<Actor> {
  const value = request.headers.get('authorization') ?? '';
  if(options.allowOAuth&&/^Bearer amo_/i.test(value)) return authenticateOAuthAccess(request,env);
  const match = /^Bearer (am_([0-9a-f-]{36})_[A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw new ServiceError('unauthorized', 401);
  const row = await env.DB.prepare(`SELECT t.id, t.mailbox_id, t.secret_sha256, t.can_read,
    t.can_read_attachments, t.can_draft, t.can_send, t.requires_approval,
    t.expires_at, t.revoked_at, m.status FROM mailbox_tokens t JOIN mailboxes m ON m.id=t.mailbox_id WHERE t.id=?`)
    .bind(match[2]).first<{ id: string; mailbox_id: string; secret_sha256: string; can_read: number;
      can_read_attachments:number; can_draft: number; can_send: number; requires_approval: number;
      expires_at: number | null; revoked_at: number | null; status: string }>();
  const digest = await sha256(match[1]);
  if (!row || !equalDigest(digest, row.secret_sha256) || row.revoked_at !== null
    || (row.expires_at !== null && row.expires_at <= Date.now()) || row.status !== 'active') {
    throw new ServiceError('unauthorized', 401);
  }
  return { kind: 'token', mailboxId: row.mailbox_id, tokenId: row.id, canRead: row.can_read === 1,
    canReadAttachments:row.can_read===1&&row.can_read_attachments===1,
    canDraft: row.can_draft === 1, canSend: row.can_send === 1, requiresApproval: row.requires_approval === 1 };
}

export function requireRead(actor: Actor | null): Extract<Actor, {kind: 'token'}> {
  if (actor?.kind !== 'token') throw new ServiceError('unauthorized', 401);
  if (!actor.canRead) throw new ServiceError('insufficient_scope', 403);
  return actor;
}

export function requireAttachments(actor:Actor|null):Extract<Actor,{kind:'token'}> {
  const caller=requireRead(actor);
  if(caller.canReadAttachments!==true)throw new ServiceError('insufficient_scope',403);
  return caller;
}

export function checkOrigin(request: Request, env: RuntimeEnv, owner: boolean): void {
  const origin = request.headers.get('origin');
  const safe = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
  // Owner writes require a browser same-origin check; bearer clients may omit Origin.
  const expected = owner ? env.CONSOLE_ORIGIN : env.API_ORIGIN;
  if ((owner && !safe && origin !== expected) || (origin !== null && origin !== expected)) {
    throw new ServiceError('forbidden_origin', 403);
  }
}
