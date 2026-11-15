import {equalDigest,sha256} from './crypto';
import {OAuthError,oauthConfig,parseScopes,randomOpaque} from './oauth';
import {ServiceError,type Actor,type RuntimeEnv} from './types';

const ACCESS_LIFETIME_MS=600_000;
const opaquePattern=/^(amo|amr|amc)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const scopeOrder=['mail:read','attachments:read','mail:draft','mail:send'];
type Kind='code'|'access'|'refresh';
interface Grant {
  grant_id:string;client_id:string;mailbox_id:string;mailbox_token_id:string;resource:string;grant_scope:string;
  grant_expires_at:number;grant_revoked_at:number|null;client_status:string;mailbox_status:string;
  can_read:number;can_read_attachments:number;can_draft:number;can_send:number;requires_approval:number;
  principal_expires_at:number|null;principal_revoked_at:number|null;
}
interface Credential extends Grant {
  credential_id:string;secret_sha256:string;expires_at:number;revoked_at?:number|null;used_at?:number|null;
  token_scope:string;redirect_uri?:string;code_challenge?:string;
}
export interface OAuthTokenResponse {
  access_token:string;token_type:'Bearer';expires_in:number;refresh_token:string;scope:string;
}
function stmt(env:RuntimeEnv,query:string,...args:(string|number|null)[]):D1PreparedStatement {
  return env.DB.prepare(query).bind(...args);
}
function inputFields(input:Record<string,string>,allowed:string[]):void {
  if(Object.keys(input).some(key=>!allowed.includes(key))||Object.values(input).some(value=>typeof value!=='string')) throw new OAuthError('invalid_request');
}
function commonInput(env:RuntimeEnv,input:Record<string,string>):void {
  if(!input.client_id||input.client_id.length>2048||/[\x00-\x1f\x7f]/.test(input.client_id)) throw new OAuthError('invalid_client');
  if(input.resource!==oauthConfig(env).resource) throw new OAuthError('invalid_target');
}
function opaqueId(value:unknown,prefix:'amo'|'amr'|'amc'):string|null {
  if(typeof value!=='string') return null;
  const match=opaquePattern.exec(value);
  return match?.[1]===prefix?match[2]:null;
}
const grantColumns=`g.id grant_id,g.client_id,g.mailbox_id,g.mailbox_token_id,g.resource,g.scope grant_scope,
  g.expires_at grant_expires_at,g.revoked_at grant_revoked_at,c.status client_status,m.status mailbox_status,
  t.can_read,t.can_read_attachments,t.can_draft,t.can_send,t.requires_approval,t.expires_at principal_expires_at,t.revoked_at principal_revoked_at`;
const grantJoins=`JOIN oauth_grants g ON g.id=k.grant_id JOIN oauth_clients c ON c.client_id=g.client_id
  JOIN mailbox_tokens t ON t.id=g.mailbox_token_id AND t.mailbox_id=g.mailbox_id JOIN mailboxes m ON m.id=g.mailbox_id`;
const credentialTables={code:'oauth_authorization_codes',access:'oauth_access_tokens',refresh:'oauth_refresh_tokens'} as const;
async function credential(env:RuntimeEnv,kind:Kind,id:string):Promise<Credential|null> {
  // The table and select fragments are selected from closed server-owned constants.
  const fields=kind==='code'?'g.scope token_scope,k.used_at,k.redirect_uri,k.code_challenge':`k.scope token_scope,k.revoked_at${kind==='refresh'?',k.used_at':''}`;
  return stmt(env,`SELECT ${grantColumns},k.id credential_id,k.secret_sha256,k.expires_at,${fields}
    FROM ${credentialTables[kind]} k ${grantJoins} WHERE k.id=?`,id).first<Credential>();
}
function live(grant:Grant,now:number):boolean {
  return grant.grant_revoked_at===null&&grant.grant_expires_at>now&&grant.client_status==='active'
    &&grant.mailbox_status==='active'&&grant.principal_revoked_at===null
    &&(grant.principal_expires_at===null||grant.principal_expires_at>now);
}
function storedScopes(value:string):string[] {
  if(typeof value!=='string'||!value.trim()) throw new OAuthError('invalid_grant');
  try{return parseScopes(value);}catch{throw new OAuthError('invalid_grant');}
}
function permittedScopes(row:Credential):string[] {
  const grant=new Set(storedScopes(row.grant_scope)),token=new Set(storedScopes(row.token_scope));
  const permissions=[row.can_read===1,row.can_read_attachments===1,row.can_draft===1,row.can_send===1];
  const allowed=scopeOrder.filter((scope,index)=>grant.has(scope)&&token.has(scope)&&permissions[index]);
  return allowed.filter(scope=>(scope!=='mail:send'||allowed.includes('mail:draft'))&&(scope!=='attachments:read'||allowed.includes('mail:read')));
}
function selectedScopes(row:Credential,requested:string|undefined):string[] {
  const allowed=permittedScopes(row);
  if(!allowed.length) throw new OAuthError('invalid_grant');
  if(requested===undefined) return allowed;
  const selected=parseScopes(requested,row.token_scope);
  if(selected.some(scope=>!allowed.includes(scope))) throw new OAuthError('invalid_scope');
  return selected;
}
function liveSql():string {
  return `g.revoked_at IS NULL AND g.expires_at>? AND c.status='active' AND m.status='active'
    AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
    AND t.can_read=? AND t.can_read_attachments=? AND t.can_draft=? AND t.can_send=? AND g.scope=? AND g.resource=? AND g.client_id=?`;
}
function liveArgs(row:Credential,now:number):(string|number)[] {
  return [now,now,row.can_read,row.can_read_attachments,row.can_draft,row.can_send,row.grant_scope,row.resource,row.client_id];
}
function audit(env:RuntimeEnv,row:Grant,id:string,action:string,requestId:string,now:number,guard:string,args:(string|number|null)[]) {
  return stmt(env,`INSERT INTO audit_events(id,mailbox_id,actor_kind,token_id,action,resource_id,outcome,request_id,metadata_json,occurred_at)
    SELECT ?,?,'token',?,?,?,'success',?,'{}',? WHERE ${guard}`,
    id,row.mailbox_id,row.mailbox_token_id,action,row.grant_id,requestId,now,...args);
}
/** Revoking a grant also revokes the stable mailbox principal, so queued sends cannot outlive consent. */
async function revokeGrant(env:RuntimeEnv,row:Grant,action:string,requestId:string):Promise<void> {
  const claim=crypto.randomUUID(),now=Date.now(),owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  await env.DB.batch([
    audit(env,row,claim,action,requestId,now,'EXISTS(SELECT 1 FROM oauth_grants WHERE id=? AND revoked_at IS NULL)',[row.grant_id]),
    stmt(env,`UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND ${owned}`,now,row.grant_id,claim),
    stmt(env,`UPDATE mailbox_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND mailbox_id=? AND ${owned}`,now,row.mailbox_token_id,row.mailbox_id,claim),
    stmt(env,`UPDATE oauth_access_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE grant_id=? AND ${owned}`,now,row.grant_id,claim),
    stmt(env,`UPDATE oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE grant_id=? AND ${owned}`,now,row.grant_id,claim)
  ]);
}
async function tokenStatements(env:RuntimeEnv,row:Credential,scope:string,claim:string,now:number) {
  const expiresIn=Math.floor((Math.min(now+ACCESS_LIFETIME_MS,row.grant_expires_at,row.principal_expires_at??Infinity)-now)/1000);
  if(expiresIn<1) throw new OAuthError('invalid_grant');
  const access=await randomOpaque('amo'),refresh=await randomOpaque('amr');
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  return {access,refresh,expiresIn,statements:[
    stmt(env,`INSERT INTO oauth_access_tokens(id,grant_id,secret_sha256,scope,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE ${owned}`,access.id,row.grant_id,access.hash,scope,now,now+expiresIn*1000,claim),
    stmt(env,`INSERT INTO oauth_refresh_tokens(id,grant_id,secret_sha256,scope,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE ${owned}`,refresh.id,row.grant_id,refresh.hash,scope,now,row.grant_expires_at,claim)
  ]};
}
function response(access:string,refresh:string,scope:string,expiresIn:number):OAuthTokenResponse {
  return {access_token:access,token_type:'Bearer',expires_in:expiresIn,refresh_token:refresh,scope};
}
async function exchangeCode(env:RuntimeEnv,input:Record<string,string>,requestId:string):Promise<OAuthTokenResponse> {
  inputFields(input,['grant_type','client_id','resource','code','redirect_uri','code_verifier','scope']);commonInput(env,input);
  const id=opaqueId(input.code,'amc');
  if(!id||!input.redirect_uri||!input.code_verifier||!/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw new OAuthError('invalid_grant');
  const row=await credential(env,'code',id),hash=await sha256(input.code);
  if(!row||!equalDigest(hash,row.secret_sha256)||row.client_id!==input.client_id||row.resource!==input.resource||row.redirect_uri!==input.redirect_uri) throw new OAuthError('invalid_grant');
  const verifierHash=await sha256(input.code_verifier);
  const challenge=btoa(String.fromCharCode(...verifierHash.match(/../g)!.map(byte=>parseInt(byte,16))))
    .replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  if(challenge!==row.code_challenge) throw new OAuthError('invalid_grant');
  if(row.used_at!==null) {await revokeGrant(env,row,'oauth.code_reuse_detected',requestId);throw new OAuthError('invalid_grant');}
  const now=Date.now();
  if(row.expires_at<=now||!live(row,now)) throw new OAuthError('invalid_grant');
  const scope=selectedScopes(row,input.scope).join(' '),claim=crypto.randomUUID(),tokens=await tokenStatements(env,row,scope,claim,now);
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const result=await env.DB.batch([
    audit(env,row,claim,'oauth.code_exchanged',requestId,now,`EXISTS(SELECT 1 FROM oauth_authorization_codes k ${grantJoins}
      WHERE k.id=? AND k.secret_sha256=? AND k.used_at IS NULL AND k.expires_at>? AND k.redirect_uri=? AND k.code_challenge=? AND ${liveSql()})`,
      [id,hash,now,input.redirect_uri,challenge,...liveArgs(row,now)]),
    stmt(env,`UPDATE oauth_authorization_codes SET used_at=? WHERE id=? AND ${owned}`,now,id,claim),
    ...tokens.statements
  ]);
  if(result[0].meta.changes!==1) {
    const current=await credential(env,'code',id);
    if(current&&current.used_at!==null) await revokeGrant(env,current,'oauth.code_reuse_detected',requestId);
    throw new OAuthError('invalid_grant');
  }
  return response(tokens.access.secret,tokens.refresh.secret,scope,tokens.expiresIn);
}
async function refreshToken(env:RuntimeEnv,input:Record<string,string>,requestId:string):Promise<OAuthTokenResponse> {
  inputFields(input,['grant_type','client_id','resource','refresh_token','scope']);commonInput(env,input);
  const id=opaqueId(input.refresh_token,'amr');
  if(!id) throw new OAuthError('invalid_grant');
  const row=await credential(env,'refresh',id),hash=await sha256(input.refresh_token);
  if(!row||!equalDigest(hash,row.secret_sha256)||row.client_id!==input.client_id||row.resource!==input.resource) throw new OAuthError('invalid_grant');
  if(row.used_at!==null) {await revokeGrant(env,row,'oauth.refresh_reuse_detected',requestId);throw new OAuthError('invalid_grant');}
  const now=Date.now();
  if(row.revoked_at!==null||row.expires_at<=now||!live(row,now)) throw new OAuthError('invalid_grant');
  const scope=selectedScopes(row,input.scope).join(' '),claim=crypto.randomUUID(),tokens=await tokenStatements(env,row,scope,claim,now);
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const result=await env.DB.batch([
    audit(env,row,claim,'oauth.refreshed',requestId,now,`EXISTS(SELECT 1 FROM oauth_refresh_tokens k ${grantJoins}
      WHERE k.id=? AND k.secret_sha256=? AND k.scope=? AND k.used_at IS NULL AND k.revoked_at IS NULL AND k.expires_at>? AND ${liveSql()})`,
      [id,hash,row.token_scope,now,...liveArgs(row,now)]),
    ...tokens.statements,
    // The replacement FK is immediate, so insert the new credential before linking the spent one.
    stmt(env,`UPDATE oauth_refresh_tokens SET used_at=?,replaced_by_id=? WHERE id=? AND ${owned}`,now,tokens.refresh.id,id,claim)
  ]);
  if(result[0].meta.changes!==1) {
    const current=await credential(env,'refresh',id);
    if(current&&current.used_at!==null) await revokeGrant(env,current,'oauth.refresh_reuse_detected',requestId);
    throw new OAuthError('invalid_grant');
  }
  return response(tokens.access.secret,tokens.refresh.secret,scope,tokens.expiresIn);
}
/** Authorization-code and refresh grants are the only supported OAuth token flows. */
export async function exchangeOAuthToken(env:RuntimeEnv,input:Record<string,string>,requestId:string):Promise<OAuthTokenResponse> {
  if(input.grant_type==='authorization_code') return exchangeCode(env,input,requestId);
  if(input.grant_type==='refresh_token') return refreshToken(env,input,requestId);
  throw new OAuthError('unsupported_grant_type');
}
/** Access tokens are audience-bound opaque credentials; no refresh/code credential is accepted as a bearer. */
export async function authenticateOAuthAccess(request:Request,env:RuntimeEnv):Promise<Actor> {
  const expected=oauthConfig(env).resource,url=new URL(request.url);
  if(`${url.origin}${url.pathname}`!==expected) throw new ServiceError('unauthorized',401);
  const value=request.headers.get('Authorization')??'',match=/^Bearer (\S+)$/i.exec(value),secret=match?.[1];
  const id=opaqueId(secret,'amo');
  if(!id||!secret) throw new ServiceError('unauthorized',401);
  const row=await credential(env,'access',id),digest=await sha256(secret),now=Date.now();
  if(!row||!equalDigest(digest,row.secret_sha256)||row.revoked_at!==null||row.expires_at<=now||row.resource!==expected||!live(row,now)) throw new ServiceError('unauthorized',401);
  let scopes:string[];
  try{scopes=permittedScopes(row);}catch{throw new ServiceError('unauthorized',401);}
  if(!scopes.length) throw new ServiceError('unauthorized',401);
  return {kind:'token',mailboxId:row.mailbox_id,tokenId:row.mailbox_token_id,canRead:scopes.includes('mail:read'),
    canReadAttachments:scopes.includes('attachments:read'),
    canDraft:scopes.includes('mail:draft'),canSend:scopes.includes('mail:send'),requiresApproval:row.requires_approval===1,
    oauthGrantId:row.grant_id,oauthAccessTokenId:row.credential_id,oauthClientId:row.client_id};
}
/** RFC7009: an unknown credential or one belonging to another client is indistinguishable from a successful revoke. */
export async function revokeOAuthToken(env:RuntimeEnv,input:Record<string,string>,requestId:string):Promise<void> {
  inputFields(input,['token','client_id','token_type_hint']);
  if(!input.client_id||input.client_id.length>2048) throw new OAuthError('invalid_client');
  if(!input.token) throw new OAuthError('invalid_request');
  const accessId=opaqueId(input.token,'amo'),refreshId=opaqueId(input.token,'amr');
  if(!accessId&&!refreshId) return;
  const row=await credential(env,accessId?'access':'refresh',(accessId??refreshId)!);
  if(!row||row.client_id!==input.client_id||!equalDigest(await sha256(input.token),row.secret_sha256)) return;
  await revokeGrant(env,row,'oauth.token_revoked',requestId);
}
