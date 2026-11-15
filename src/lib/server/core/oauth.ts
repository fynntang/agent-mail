import {equalDigest,sha256} from './crypto';
import {listMailboxes,requireOwner,type OwnerContext} from './owner';
import {readBounded} from './storage';
import {ServiceError,type RuntimeEnv} from './types';

export class OAuthError extends Error {
  constructor(public error:string,public status=400,public redirectUrl?:string) {super(error);}
}
export const oauthScopes=['mail:read','attachments:read','mail:draft','mail:send'] as const;
const day=86_400_000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function oauthConfig(env:RuntimeEnv) {
  const origin=(value:string)=>{
    try {
      const url=new URL(value),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
      if((url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))||url.origin!==value||url.username||url.password) throw new Error();
      return url.origin;
    }catch {throw new OAuthError('server_error',503);}
  };
  const issuer=origin(env.API_ORIGIN),consoleOrigin=origin(env.CONSOLE_ORIGIN);
  return {issuer,resource:`${issuer}/mcp`,authorizationEndpoint:`${consoleOrigin}/owner/oauth/authorize`};
}
export function parseScopes(value:unknown,fallback='mail:read'):string[] {
  if(value===undefined||value===null) value=fallback;
  if(typeof value!=='string'||value.length>100||!value.trim()) throw new OAuthError('invalid_scope');
  const values=value.trim().split(/ +/);
  if(values.some(scope=>!(oauthScopes as readonly string[]).includes(scope))||new Set(values).size!==values.length
    ||(values.includes('mail:send')&&!values.includes('mail:draft'))
    ||(values.includes('attachments:read')&&!values.includes('mail:read'))) throw new OAuthError('invalid_scope');
  return oauthScopes.filter(scope=>values.includes(scope));
}
export async function randomOpaque(prefix:'amo'|'amr'|'amc') {
  const id=crypto.randomUUID(),bytes=crypto.getRandomValues(new Uint8Array(32));
  const random=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const secret=`${prefix}_${id}_${random}`;
  return {id,secret,hash:await sha256(secret)};
}
export function trustedCimdHosts(env:RuntimeEnv):string[] {
  return (env.OAUTH_CIMD_ALLOWED_HOSTS??'').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean)
    .filter(host=>host.length<=253&&!host.endsWith('.localhost')&&host!=='localhost'&&!host.endsWith('.local')
      &&!/^[\d.]+$/.test(host)&&host.includes('.')&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
}
export function redirectUri(value:unknown):string {
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f]/.test(value)) throw new OAuthError('invalid_client_metadata');
  try {
    const url=new URL(value),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))||url.username||url.password||url.hash) throw new Error();
    return value; // Exact registered strings, including the port and query; no wildcard or prefix matching.
  }catch {throw new OAuthError('invalid_client_metadata');}
}
export function registeredRedirect(registered:string[],requested:string):boolean {
  if(registered.includes(requested)) return true;
  try {
    const url=new URL(redirectUri(requested));
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)) return false;
    const withoutPort=(uri:string)=>uri.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?(?=\/|\?|$)/,'$1');
    return registered.some(uri=>withoutPort(uri)===withoutPort(requested));
  }catch{return false;}
}
interface ClientRow {
  client_id:string;kind:'dynamic'|'cimd';client_name:string;redirect_uris_json:string;scope:string;status:string;created_at:number;metadata_expires_at:number|null;
}
function clientMetadata(input:unknown,requireName=false) {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new OAuthError('invalid_client_metadata');
  const data=input as Record<string,unknown>;
  const name=data.client_name===undefined&&!requireName?'未命名 MCP 客户端':data.client_name;
  if(typeof name!=='string'||!name.trim()||name.trim().length>80||/[\x00-\x1f\x7f]/.test(name)) throw new OAuthError('invalid_client_metadata');
  if(!Array.isArray(data.redirect_uris)||!data.redirect_uris.length||data.redirect_uris.length>10) throw new OAuthError('invalid_redirect_uri');
  const redirects=[...new Set(data.redirect_uris.map(redirectUri))];
  if(data.token_endpoint_auth_method!==undefined&&data.token_endpoint_auth_method!=='none') throw new OAuthError('invalid_client_metadata');
  const grants=data.grant_types??['authorization_code','refresh_token'],responses=data.response_types??['code'];
  if(!Array.isArray(grants)||!grants.includes('authorization_code')||grants.some(item=>!['authorization_code','refresh_token'].includes(item))
    ||!Array.isArray(responses)||responses.length!==1||responses[0]!=='code') throw new OAuthError('invalid_client_metadata');
  return {name:name.trim(),redirects,scope:parseScopes(data.scope,oauthScopes.join(' ')).join(' ')};
}
export async function registerOAuthClient(env:RuntimeEnv,input:unknown) {
  oauthConfig(env);
  const data=clientMetadata(input),now=Date.now(),window=Math.floor(now/60_000)*60_000;
  const claim=await env.DB.prepare(`INSERT INTO oauth_registration_windows(window_start,count) VALUES(?,1)
    ON CONFLICT(window_start) DO UPDATE SET count=count+1 WHERE count<30`).bind(window).run();
  if(claim.meta.changes!==1) throw new OAuthError('temporarily_unavailable',429);
  await env.DB.prepare('DELETE FROM oauth_registration_windows WHERE window_start<?').bind(window-60_000).run();
  const id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO oauth_clients(client_id,kind,client_name,redirect_uris_json,scope,created_at)
    VALUES(?,'dynamic',?,?,?,?)`).bind(id,data.name,JSON.stringify(data.redirects),data.scope,now).run();
  return {client_id:id,client_id_issued_at:Math.floor(now/1000),client_name:data.name,redirect_uris:data.redirects,
    token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:data.scope};
}
async function resolveClient(env:RuntimeEnv,id:string):Promise<ClientRow> {
  if(id.length>2048) throw new OAuthError('invalid_client');
  const existing=await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id=?').bind(id).first<ClientRow>();
  if(existing?.status==='disabled') throw new OAuthError('invalid_client');
  if(existing?.kind==='dynamic') return existing;
  let url:URL;
  try {
    if(/[\\\x00-\x20\x7f]/.test(id)) throw new Error();
    url=new URL(id);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname==='/'
      ||!trustedCimdHosts(env).includes(url.hostname.toLowerCase())
      ||/(?:^|\/)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(id.replace(/^https:\/\/[^/]+/i,''))) throw new Error();
  }catch {throw new OAuthError('invalid_client');}
  if(existing?.metadata_expires_at&&existing.metadata_expires_at>Date.now()) return existing;
  let metadata:unknown;
  try {
    const response=await fetch(url,{headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(5_000)});
    const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if(response.status!==200||!response.body||!(type==='application/json'||type?.endsWith('+json'))) throw new Error();
    metadata=JSON.parse(new TextDecoder().decode(await readBounded(response.body,5*1024)));
    if(!metadata||typeof metadata!=='object'||!('client_id' in metadata)||metadata.client_id!==id) throw new Error();
  }catch {throw new OAuthError('invalid_client');}
  const data=clientMetadata(metadata,true),now=Date.now();
  await env.DB.prepare(`INSERT INTO oauth_clients(client_id,kind,client_name,redirect_uris_json,scope,created_at,metadata_expires_at)
    VALUES(?,'cimd',?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET client_name=excluded.client_name,
      redirect_uris_json=excluded.redirect_uris_json,scope=excluded.scope,metadata_expires_at=excluded.metadata_expires_at WHERE oauth_clients.status='active'`)
    .bind(id,data.name,JSON.stringify(data.redirects),data.scope,now,now+5*60_000).run();
  return (await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id=? AND status='active'").bind(id).first<ClientRow>())!;
}
interface AuthRequest {
  id:string;client_id:string;redirect_uri:string;resource:string;requested_scope:string;state:string|null;code_challenge:string;
  owner_email:string;csrf_sha256:string;created_at:number;expires_at:number;used_at:number|null;
}
function callback(redirect:string,params:Record<string,string|null>):string {
  const url=new URL(redirect);
  for(const key of ['code','error','error_description','state','iss']) url.searchParams.delete(key);
  for(const [key,value] of Object.entries(params)) {url.searchParams.delete(key);if(value!==null) url.searchParams.set(key,value);}
  return url.href;
}
export async function createAuthorizationRequest(ctx:OwnerContext,params:URLSearchParams) {
  const owner=requireOwner(ctx.actor),config=oauthConfig(ctx.env);
  for(const key of ['client_id','redirect_uri','response_type','resource','scope','state','code_challenge','code_challenge_method']) {
    if(params.getAll(key).length>1) throw new OAuthError('invalid_request');
  }
  const id=params.get('client_id'),redirect=params.get('redirect_uri');
  if(!id||!redirect) throw new OAuthError('invalid_request');
  const client=await resolveClient(ctx.env,id);
  if(!registeredRedirect(JSON.parse(client.redirect_uris_json),redirect)) throw new OAuthError('invalid_redirect_uri');
  const challenge=params.get('code_challenge'),state=params.get('state');
  if(state!==null&&(state.length>512||/[\x00-\x1f\x7f]/.test(state))) throw new OAuthError('invalid_request');
  let scope:string[];
  try {
    scope=parseScopes(params.get('scope'));
    if(scope.some(value=>!client.scope.split(' ').includes(value))) throw new OAuthError('invalid_scope');
    if(params.get('response_type')!=='code') throw new OAuthError('unsupported_response_type');
    if(params.get('resource')!==config.resource||params.get('code_challenge_method')!=='S256'||!challenge||!/^[A-Za-z0-9_-]{43}$/.test(challenge)
      ||(params.has('response_mode')&&params.get('response_mode')!=='query')) throw new OAuthError('invalid_request');
  }catch(error) {
    if(error instanceof OAuthError) error.redirectUrl=callback(redirect,{error:error.error,state,iss:config.issuer});
    throw error;
  }
  const handle=crypto.randomUUID(),nonce=(await randomOpaque('amc')).secret,now=Date.now();
  await ctx.env.DB.prepare(`INSERT INTO oauth_authorization_requests(id,client_id,redirect_uri,resource,requested_scope,state,code_challenge,owner_email,csrf_sha256,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(handle,id,redirect,config.resource,scope.join(' '),state,challenge,owner.email.toLowerCase(),await sha256(nonce),now,now+10*60_000).run();
  const redirectUrl=new URL(redirect);
  return {id:handle,csrfToken:nonce,client:{id,name:client.client_name,kind:client.kind,metadataHost:client.kind==='cimd'?new URL(id).hostname:null},
    redirectUri:redirect,redirectHost:redirectUrl.host,loopback:['127.0.0.1','localhost','[::1]'].includes(redirectUrl.hostname),requestedScopes:scope,expiresAt:now+10*60_000,
    mailboxes:(await listMailboxes(ctx)).filter(box=>box.status==='active')};
}
export async function decideAuthorization(ctx:OwnerContext,input:{requestId:string;csrfToken:string;decision:'allow'|'deny';mailboxId?:string;scopes?:string[];requiresApproval?:boolean}) {
  const owner=requireOwner(ctx.actor),config=oauthConfig(ctx.env),now=Date.now();
  if(typeof input.requestId!=='string'||!uuid.test(input.requestId)||typeof input.csrfToken!=='string'||input.csrfToken.length>128) throw new OAuthError('invalid_request');
  const row=await ctx.env.DB.prepare('SELECT * FROM oauth_authorization_requests WHERE id=?').bind(input.requestId).first<AuthRequest>();
  if(!row||row.used_at!==null||row.expires_at<=now||row.owner_email!==owner.email.toLowerCase()||!equalDigest(row.csrf_sha256,await sha256(input.csrfToken))) throw new OAuthError('invalid_request');
  const client=await ctx.env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id=? AND status='active'").bind(row.client_id).first<ClientRow>();
  if(!client||!registeredRedirect(JSON.parse(client.redirect_uris_json),row.redirect_uri)||row.resource!==config.resource) throw new OAuthError('invalid_client');
  if(input.decision==='deny') {
    const denied=await ctx.env.DB.prepare('UPDATE oauth_authorization_requests SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').bind(now,row.id,now).run();
    if(denied.meta.changes!==1) throw new OAuthError('invalid_request');
    return {redirectUrl:callback(row.redirect_uri,{error:'access_denied',state:row.state,iss:config.issuer})};
  }
  if(input.decision!=='allow'||!Array.isArray(input.scopes)) throw new OAuthError('invalid_request');
  const scopes=parseScopes(input.scopes.join(' '));
  if(scopes.some(scope=>!row.requested_scope.split(' ').includes(scope)||!client.scope.split(' ').includes(scope))) throw new OAuthError('invalid_scope');
  const approval=input.requiresApproval??true;
  if(typeof approval!=='boolean'||(!approval&&!scopes.includes('mail:send'))) throw new OAuthError('invalid_request');
  if(typeof input.mailboxId!=='string'||!uuid.test(input.mailboxId)) throw new OAuthError('invalid_request');
  const box=await ctx.env.DB.prepare("SELECT id FROM mailboxes WHERE id=? AND status='active'").bind(input.mailboxId).first();
  if(!box) throw new OAuthError('invalid_request');
  const principal=crypto.randomUUID(),grant=crypto.randomUUID(),code=await randomOpaque('amc'),expires=now+30*day,claim=crypto.randomUUID();
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
      SELECT ?,?,'owner','oauth.granted',?,'success',?,?,? WHERE EXISTS(SELECT 1 FROM oauth_authorization_requests r
      JOIN oauth_clients c ON c.client_id=r.client_id WHERE r.id=? AND r.used_at IS NULL AND r.expires_at>? AND c.status='active'
      AND c.redirect_uris_json=? AND c.scope=?)
      AND EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active')`).bind(claim,input.mailboxId,grant,ctx.requestId,JSON.stringify({clientId:row.client_id,scopes,requiresApproval:approval}),now,row.id,now,client.redirect_uris_json,client.scope,input.mailboxId),
    ctx.env.DB.prepare(`INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,can_read,can_read_attachments,can_draft,can_send,requires_approval,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${owned}`).bind(principal,input.mailboxId,`OAuth · ${client.client_name}`.slice(0,80),await sha256((await randomOpaque('amo')).secret),
        scopes.includes('mail:read')?1:0,scopes.includes('attachments:read')?1:0,scopes.includes('mail:draft')?1:0,scopes.includes('mail:send')?1:0,approval?1:0,expires,now,claim),
    ctx.env.DB.prepare(`INSERT INTO oauth_grants(id,client_id,mailbox_id,mailbox_token_id,resource,scope,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${owned}`).bind(grant,row.client_id,input.mailboxId,principal,row.resource,scopes.join(' '),now,expires,claim),
    ctx.env.DB.prepare(`INSERT INTO oauth_authorization_codes(id,grant_id,secret_sha256,redirect_uri,code_challenge,created_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE ${owned}`).bind(code.id,grant,code.hash,row.redirect_uri,row.code_challenge,now,now+2*60_000,claim),
    ctx.env.DB.prepare(`UPDATE oauth_authorization_requests SET used_at=? WHERE id=? AND ${owned}`).bind(now,row.id,claim)
  ]);
  if(result[2].meta.changes!==1) throw new OAuthError('invalid_request');
  return {redirectUrl:callback(row.redirect_uri,{code:code.secret,state:row.state,iss:config.issuer})};
}
export async function listOAuthGrants(ctx:OwnerContext) {
  requireOwner(ctx.actor);
  const {results}=await ctx.env.DB.prepare(`SELECT g.id,g.client_id,g.mailbox_id,g.scope,g.created_at,g.expires_at,g.revoked_at,c.client_name,
    t.requires_approval,t.revoked_at token_revoked_at,m.name mailbox_name,a.address FROM oauth_grants g
    JOIN oauth_clients c ON c.client_id=g.client_id JOIN mailbox_tokens t ON t.id=g.mailbox_token_id AND t.mailbox_id=g.mailbox_id
    JOIN mailboxes m ON m.id=g.mailbox_id JOIN mailbox_addresses a ON a.mailbox_id=m.id AND a.is_primary=1 ORDER BY g.created_at DESC,g.id DESC LIMIT 100`)
    .all<{id:string;client_id:string;mailbox_id:string;scope:string;created_at:number;expires_at:number;revoked_at:number|null;client_name:string;
      requires_approval:number;token_revoked_at:number|null;mailbox_name:string;address:string}>();
  return results.map(row=>({id:row.id,clientId:row.client_id,clientName:row.client_name,mailboxId:row.mailbox_id,mailboxName:row.mailbox_name,mailboxAddress:row.address,
    scopes:row.scope.split(' '),requiresApproval:row.requires_approval===1,createdAt:row.created_at,expiresAt:row.expires_at,
    revokedAt:row.revoked_at??row.token_revoked_at,state:(row.revoked_at!==null||row.token_revoked_at!==null?'revoked':row.expires_at<=Date.now()?'expired':'active') as 'active'|'expired'|'revoked'}));
}
export async function revokeOAuthGrant(ctx:OwnerContext,id:string) {
  requireOwner(ctx.actor);if(!uuid.test(id)) throw new ServiceError('not_found',404);
  const grant=await ctx.env.DB.prepare('SELECT mailbox_id,mailbox_token_id FROM oauth_grants WHERE id=?').bind(id).first<{mailbox_id:string;mailbox_token_id:string}>();
  if(!grant) throw new ServiceError('not_found',404);
  const now=Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now,id),
    ctx.env.DB.prepare('UPDATE mailbox_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND mailbox_id=?').bind(now,grant.mailbox_token_id,grant.mailbox_id),
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
      VALUES(?,?,'owner','oauth.revoked',?,'success',?,'{}',?)`).bind(crypto.randomUUID(),grant.mailbox_id,id,ctx.requestId,now)
  ]);
}
