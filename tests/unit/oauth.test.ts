import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,issueToken,revokeToken,updateMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {approveDraft,requestSend,saveDraft} from '../../src/lib/server/core/outbound';
import {runSendJobs} from '../../src/lib/server/core/outbound-jobs';
import {createAuthorizationRequest,decideAuthorization,registerOAuthClient,parseScopes} from '../../src/lib/server/core/oauth';
import {authenticateMailbox} from '../../src/lib/server/core/auth';
import {authenticateOAuthAccess,exchangeOAuthToken,revokeOAuthToken} from '../../src/lib/server/core/oauth-tokens';
import {sha256} from '../../src/lib/server/core/crypto';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

const resource='https://api.example.com/mcp',redirect='https://client.example/callback';
const fullScopes=['mail:read','mail:draft','mail:send'];
let mf:Miniflare,ctx:OwnerContext,schema:string[];
beforeAll(async()=>{
  schema=[];
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
    schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
  }
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'oauth-core'},r2Buckets:{MAIL_BLOBS:'oauth-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  await db.batch(schema.map(sql=>db.prepare(sql)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',
    API_ORIGIN:'https://api.example.com',CONSOLE_ORIGIN:'https://console.example.com',
    EMAIL:{send:async()=>({messageId:crypto.randomUUID()})}} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);

const count=(query:string,...args:(string|number)[])=>ctx.env.DB.prepare(query).bind(...args).first<number>('n');
function bearer(secret:string,url=resource) {return new Request(url,{headers:{Authorization:`Bearer ${secret}`}});}
async function prepare(options:{scopes?:string[];requiresApproval?:boolean}={}) {
  const scopes=options.scopes??fullScopes;
  const box=await createMailbox(ctx,{name:'OAuth mailbox',localPart:`oauth-${crypto.randomUUID()}`});
  const client=await registerOAuthClient(ctx.env,{client_name:'Unit client',redirect_uris:[redirect],
    token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],scope:['mail:read','attachments:read','mail:draft','mail:send'].join(' ')});
  const verifier='v'.repeat(64),digest=await sha256(verifier);
  const challenge=Buffer.from(digest,'hex').toString('base64url');
  const pending=await createAuthorizationRequest(ctx,new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,
    response_type:'code',resource,scope:scopes.join(' '),state:'unit-state',code_challenge:challenge,code_challenge_method:'S256'}));
  const decision=await decideAuthorization(ctx,{requestId:pending.id,csrfToken:pending.csrfToken,decision:'allow',mailboxId:box.id,
    scopes,...(options.requiresApproval===undefined?{}:{requiresApproval:options.requiresApproval})});
  const callback=new URL(decision.redirectUrl),code=callback.searchParams.get('code')!;
  expect(callback.searchParams.get('state')).toBe('unit-state');expect(callback.searchParams.get('iss')).toBe(ctx.env.API_ORIGIN);
  const form={grant_type:'authorization_code',client_id:client.client_id,resource,code,redirect_uri:redirect,code_verifier:verifier};
  const grant=await ctx.env.DB.prepare(`SELECT g.* FROM oauth_grants g JOIN oauth_authorization_codes c ON c.grant_id=g.id WHERE c.secret_sha256=?`)
    .bind(await sha256(code)).first<{id:string;mailbox_token_id:string;expires_at:number}>();
  return {box,client,pending,form,grant:grant!};
}
async function issue(options:Parameters<typeof prepare>[0]={}) {
  const prepared=await prepare(options),tokens=await exchangeOAuthToken(ctx.env,prepared.form,crypto.randomUUID());
  return {...prepared,tokens};
}
function refreshForm(clientId:string,refreshToken:string,scope?:string) {
  return {grant_type:'refresh_token',client_id:clientId,resource,refresh_token:refreshToken,...(scope===undefined?{}:{scope})};
}
function changedSecret(secret:string) {return secret.slice(0,-1)+(secret.endsWith('a')?'b':'a');}
const mail={to:['recipient@example.net'],subject:'OAuth test',text:'Task completed.'};

it('keeps attachment download permission explicit for static Tokens and requires mail:read',async()=>{
  const box=await createMailbox(ctx,{name:'Attachment scope',localPart:`attachment-${crypto.randomUUID()}`});
  await expect(issueToken(ctx,box.id,{name:'invalid',scopes:['attachments:read']})).rejects.toMatchObject({code:'unsupported_scopes'});
  expect(()=>parseScopes('attachments:read')).toThrow('invalid_scope');
  const readonly=await issueToken(ctx,box.id,{name:'metadata only',scopes:['mail:read']});
  expect(await authenticateMailbox(bearer(readonly.secret),ctx.env)).toMatchObject({canRead:true,canReadAttachments:false});
  const full=await issueToken(ctx,box.id,{name:'explicit attachment grant',scopes:['attachments:read','mail:read']});
  expect(full.token.scopes).toEqual(['mail:read','attachments:read']);
  expect(await ctx.env.DB.prepare('SELECT can_read_attachments FROM mailbox_tokens WHERE id=?').bind(full.token.id).first('can_read_attachments')).toBe(1);
  expect(await authenticateMailbox(bearer(full.secret),ctx.env)).toMatchObject({canRead:true,canReadAttachments:true});
  await revokeToken(ctx,box.id,full.token.id);
  await expect(authenticateMailbox(bearer(full.secret),ctx.env)).rejects.toMatchObject({status:401});
});

it('binds OAuth attachments to explicit consent and narrows refreshed access without widening the principal',async()=>{
  const p=await issue({scopes:['mail:read','attachments:read']});
  expect(p.tokens.scope).toBe('mail:read attachments:read');
  expect(await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).toMatchObject({canRead:true,canReadAttachments:true});
  expect(await ctx.env.DB.prepare('SELECT can_read_attachments FROM mailbox_tokens WHERE id=?').bind(p.grant.mailbox_token_id).first('can_read_attachments')).toBe(1);
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token,'https://api.example.com/v1/messages/x/attachments/y/download'),ctx.env)).rejects.toMatchObject({status:401});
  const narrowed=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token,'mail:read'),crypto.randomUUID());
  expect(narrowed.scope).toBe('mail:read');
  expect(await authenticateOAuthAccess(bearer(narrowed.access_token),ctx.env)).toMatchObject({canRead:true,canReadAttachments:false});
  expect(await ctx.env.DB.prepare('SELECT can_read_attachments FROM mailbox_tokens WHERE id=?').bind(p.grant.mailbox_token_id).first('can_read_attachments')).toBe(1);
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,narrowed.refresh_token,'mail:read attachments:read'),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_scope'});
  await ctx.env.DB.prepare('UPDATE mailbox_tokens SET can_read_attachments=0 WHERE id=?').bind(p.grant.mailbox_token_id).run();
  expect(await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).toMatchObject({canRead:true,canReadAttachments:false});
  const legacy=await issue({scopes:['mail:read']});
  expect(await authenticateOAuthAccess(bearer(legacy.tokens.access_token),ctx.env)).toMatchObject({canRead:true,canReadAttachments:false});
});

async function pendingConsent(scopes=['mail:read']) {
  const box=await createMailbox(ctx,{name:'Consent mailbox',localPart:`consent-${crypto.randomUUID()}`});
  const client=await registerOAuthClient(ctx.env,{client_name:'Consent client',redirect_uris:[redirect],scope:fullScopes.join(' '),token_endpoint_auth_method:'none'});
  const challenge=Buffer.from(await sha256('p'.repeat(64)),'hex').toString('base64url');
  const pending=await createAuthorizationRequest(ctx,new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,
    response_type:'code',resource,scope:scopes.join(' '),state:'consent-state',code_challenge:challenge,code_challenge_method:'S256'}));
  return {box,pending,input:{requestId:pending.id,csrfToken:pending.csrfToken,decision:'allow' as const,mailboxId:box.id,scopes}};
}

it('claims an Owner consent nonce only once under concurrent approval without duplicate principals or grants',async()=>{
  const p=await pendingConsent();
  const results=await Promise.allSettled([1,2].map(()=>decideAuthorization(ctx,p.input)));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({error:'invalid_request'});
  for(const table of ['mailbox_tokens','oauth_grants','oauth_authorization_codes']) expect(await count(`SELECT count(*) n FROM ${table}`)).toBe(1);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.granted'")).toBe(1);
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_authorization_requests WHERE id=?').bind(p.pending.id).first('used_at')).not.toBeNull();
});

it('rejects wrong consent CSRF, a different Owner, scope escalation and expired consent before all mutations',async()=>{
  const p=await pendingConsent();
  await expect(decideAuthorization(ctx,{...p.input,csrfToken:changedSecret(p.input.csrfToken)})).rejects.toMatchObject({error:'invalid_request'});
  await expect(decideAuthorization({...ctx,actor:{kind:'owner',email:'another-owner@example.com'}},p.input)).rejects.toMatchObject({error:'invalid_request'});
  await expect(decideAuthorization(ctx,{...p.input,scopes:fullScopes})).rejects.toMatchObject({error:'invalid_scope'});
  await expect(decideAuthorization(ctx,{...p.input,requiresApproval:false})).rejects.toMatchObject({error:'invalid_request'});
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_authorization_requests WHERE id=?').bind(p.pending.id).first('used_at')).toBeNull();
  vi.spyOn(Date,'now').mockReturnValue(p.pending.expiresAt+1);
  for(const decision of ['allow','deny'] as const) await expect(decideAuthorization(ctx,{...p.input,decision})).rejects.toMatchObject({error:'invalid_request'});
  for(const table of ['mailbox_tokens','oauth_grants','oauth_authorization_codes']) expect(await count(`SELECT count(*) n FROM ${table}`)).toBe(0);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.granted'")).toBe(0);
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_authorization_requests WHERE id=?').bind(p.pending.id).first('used_at')).toBeNull();
});

it('binds authorization codes to PKCE, client, exact redirect and resource before consuming them',async()=>{
  const p=await prepare();
  for(const override of [{code_verifier:'wrong'.repeat(13)},{client_id:crypto.randomUUID()},
    {redirect_uri:`${redirect}?different=1`},{code:changedSecret(p.form.code)}]) {
    await expect(exchangeOAuthToken(ctx.env,{...p.form,...override},crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  }
  await expect(exchangeOAuthToken(ctx.env,{...p.form,resource:'https://other.example/mcp'},crypto.randomUUID())).rejects.toMatchObject({error:'invalid_target'});
  await expect(exchangeOAuthToken(ctx.env,{...p.form,code_verifier:'short'},crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  expect(await count('SELECT count(*) n FROM oauth_access_tokens')).toBe(0);
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_authorization_codes').first('used_at')).toBeNull();
  const token=await exchangeOAuthToken(ctx.env,p.form,crypto.randomUUID());
  expect(token).toMatchObject({token_type:'Bearer',expires_in:600,scope:fullScopes.join(' ')});
  expect(await authenticateOAuthAccess(bearer(token.access_token),ctx.env)).toMatchObject({mailboxId:p.box.id,
    tokenId:p.grant.mailbox_token_id,oauthGrantId:p.grant.id,oauthClientId:p.client.client_id,requiresApproval:true,canSend:true});
  for(const credential of [p.form.code,token.refresh_token]) await expect(authenticateOAuthAccess(bearer(credential),ctx.env)).rejects.toMatchObject({status:401});
  for(const url of ['https://api.example.com/v1/messages','https://other.example/mcp']) {
    await expect(authenticateOAuthAccess(bearer(token.access_token,url),ctx.env)).rejects.toMatchObject({status:401});
  }
});

it('keeps invalid code proofs harmless, but revokes the issued family when a valid spent code is replayed',async()=>{
  const p=await issue();
  await expect(exchangeOAuthToken(ctx.env,{...p.form,code_verifier:'x'.repeat(64)},crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  expect((await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).kind).toBe('token');
  await expect(exchangeOAuthToken(ctx.env,p.form,crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).rejects.toMatchObject({status:401});
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.code_exchanged'")).toBe(1);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.code_reuse_detected'")).toBe(1);
  expect(await ctx.env.DB.prepare('SELECT revoked_at FROM mailbox_tokens WHERE id=?').bind(p.grant.mailbox_token_id).first('revoked_at')).not.toBeNull();
});

it('atomically consumes a code once under concurrent exchange and fences the replayed family',async()=>{
  const p=await prepare();
  const results=await Promise.allSettled([1,2].map(()=>exchangeOAuthToken(ctx.env,p.form,crypto.randomUUID())));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({error:'invalid_grant'});
  expect(await count('SELECT count(*) n FROM oauth_access_tokens')).toBe(1);
  expect(await count('SELECT count(*) n FROM oauth_refresh_tokens')).toBe(1);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.code_exchanged'")).toBe(1);
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_authorization_codes').first('used_at')).not.toBeNull();
  const winner=(results.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof exchangeOAuthToken>>>).value;
  await expect(authenticateOAuthAccess(bearer(winner.access_token),ctx.env)).rejects.toMatchObject({status:401});
});

it('rotates refresh credentials with a stable draft principal, supports downscope, and revokes on replay',async()=>{
  const p=await issue(),original=await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env);
  const renewed=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token,'mail:read mail:draft'),crypto.randomUUID());
  expect(renewed.refresh_token).not.toBe(p.tokens.refresh_token);expect(renewed.access_token).not.toBe(p.tokens.access_token);
  expect(renewed.scope).toBe('mail:read mail:draft');
  const actor=await authenticateOAuthAccess(bearer(renewed.access_token),ctx.env);
  expect(actor).toMatchObject({tokenId:original.kind==='token'?original.tokenId:'',canRead:true,canDraft:true,canSend:false,requiresApproval:true});
  const old=await ctx.env.DB.prepare('SELECT used_at,replaced_by_id FROM oauth_refresh_tokens WHERE secret_sha256=?').bind(await sha256(p.tokens.refresh_token))
    .first<{used_at:number|null;replaced_by_id:string|null}>();
  expect(old?.used_at).not.toBeNull();expect(old?.replaced_by_id).toBe(renewed.refresh_token.split('_')[1]);
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  for(const token of [p.tokens.access_token,renewed.access_token]) await expect(authenticateOAuthAccess(bearer(token),ctx.env)).rejects.toMatchObject({status:401});
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.refresh_reuse_detected'")).toBe(1);
});

it('does not let guessed token IDs, wrong client IDs or wrong secrets revoke legitimate grants',async()=>{
  const p=await issue(),wrongRefresh=changedSecret(p.tokens.refresh_token);
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,wrongRefresh),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  await expect(exchangeOAuthToken(ctx.env,refreshForm(crypto.randomUUID(),p.tokens.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  await revokeOAuthToken(ctx.env,{client_id:p.client.client_id,token:wrongRefresh},crypto.randomUUID());
  await revokeOAuthToken(ctx.env,{client_id:crypto.randomUUID(),token:p.tokens.access_token},crypto.randomUUID());
  await revokeOAuthToken(ctx.env,{client_id:p.client.client_id,token:'unknown-credential'},crypto.randomUUID());
  await expect(authenticateOAuthAccess(bearer(changedSecret(p.tokens.access_token)),ctx.env)).rejects.toMatchObject({status:401});
  expect((await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).kind).toBe('token');
  expect(await ctx.env.DB.prepare('SELECT revoked_at FROM oauth_grants WHERE id=?').bind(p.grant.id).first('revoked_at')).toBeNull();
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_refresh_tokens').first('used_at')).toBeNull();
});

it('rotates a refresh token only once under concurrent use and revokes the racing replay family',async()=>{
  const p=await issue(),form=refreshForm(p.client.client_id,p.tokens.refresh_token);
  const results=await Promise.allSettled([1,2].map(()=>exchangeOAuthToken(ctx.env,form,crypto.randomUUID())));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({error:'invalid_grant'});
  expect(await count('SELECT count(*) n FROM oauth_access_tokens')).toBe(2);
  expect(await count('SELECT count(*) n FROM oauth_refresh_tokens')).toBe(2);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.refreshed'")).toBe(1);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='oauth.refresh_reuse_detected'")).toBe(1);
  const winner=(results.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof exchangeOAuthToken>>>).value;
  await expect(authenticateOAuthAccess(bearer(winner.access_token),ctx.env)).rejects.toMatchObject({status:401});
  expect(await ctx.env.DB.prepare('SELECT revoked_at FROM mailbox_tokens WHERE id=?').bind(p.grant.mailbox_token_id).first('revoked_at')).not.toBeNull();
});

it('rejects refresh scope escalation, invalid resource and unsupported grants without consuming the refresh token',async()=>{
  const p=await issue({scopes:['mail:read']});
  for(const scope of ['mail:read attachments:read','mail:read mail:draft','mail:draft mail:send','*','mail:send']) {
    await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token,scope),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_scope'});
  }
  await expect(exchangeOAuthToken(ctx.env,{...refreshForm(p.client.client_id,p.tokens.refresh_token),resource:'https://api.example.com/v1'},crypto.randomUUID())).rejects.toMatchObject({error:'invalid_target'});
  await expect(exchangeOAuthToken(ctx.env,{grant_type:'client_credentials',client_id:p.client.client_id,resource},crypto.randomUUID())).rejects.toMatchObject({error:'unsupported_grant_type'});
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_refresh_tokens').first('used_at')).toBeNull();
  const renewed=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID());
  expect(renewed.scope).toBe('mail:read');
});

it('stores only digests for OAuth secrets and never persists the PKCE verifier',async()=>{
  const p=await issue();
  const tables=['oauth_clients','oauth_authorization_requests','oauth_grants','oauth_authorization_codes','oauth_access_tokens','oauth_refresh_tokens','mailbox_tokens','audit_events'];
  const rows=await Promise.all(tables.map(table=>ctx.env.DB.prepare(`SELECT * FROM ${table}`).all()));
  const dump=JSON.stringify(rows);
  for(const secret of [p.pending.csrfToken,p.form.code,p.form.code_verifier,p.tokens.access_token,p.tokens.refresh_token]) expect(dump).not.toContain(secret);
  expect(dump).toContain(await sha256(p.form.code));expect(dump).toContain(await sha256(p.tokens.access_token));
  expect(dump).toContain(await sha256(p.tokens.refresh_token));
});

it('reuses Owner approval after refresh without treating OAuth consent as permission to send directly',async()=>{
  const p=await issue(),actor=await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env),agent={...ctx,actor};
  const draft=await saveDraft(agent,p.box.id,mail);
  expect(await requestSend(agent,p.box.id,draft.id,{expectedVersion:1},'oauth-request')).toMatchObject({status:'approval_required'});
  expect(await count('SELECT count(*) n FROM outbound_messages')).toBe(0);
  await approveDraft(ctx,p.box.id,draft.id,{expectedVersion:1,contentSha256:draft.contentSha256});
  const renewed=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID());
  const refreshed={...ctx,actor:await authenticateOAuthAccess(bearer(renewed.access_token),ctx.env)};
  expect(refreshed.actor).toMatchObject({tokenId:p.grant.mailbox_token_id,requiresApproval:true});
  expect(await requestSend(refreshed,p.box.id,draft.id,{expectedVersion:1},'oauth-approved')).toMatchObject({status:'queued'});
  expect(await count('SELECT count(*) n FROM outbound_messages')).toBe(1);
});

it('revokes the stable principal and blocks queued mail when a valid OAuth token is revoked',async()=>{
  const p=await issue({requiresApproval:false}),agent={...ctx,actor:await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)};
  const draft=await saveDraft(agent,p.box.id,mail);
  expect(await requestSend(agent,p.box.id,draft.id,{expectedVersion:1},'oauth-direct')).toMatchObject({status:'queued'});
  await revokeOAuthToken(ctx.env,{client_id:p.client.client_id,token:p.tokens.refresh_token,token_type_hint:'refresh_token'},crypto.randomUUID());
  const send=vi.fn(async()=>({messageId:crypto.randomUUID()}));
  await runSendJobs(ctx.env,{sender:send});expect(send).not.toHaveBeenCalled();
  expect(await ctx.env.DB.prepare('SELECT status FROM outbound_messages').first('status')).toBe('failed');
  expect(await ctx.env.DB.prepare('SELECT state FROM send_reservations').first('state')).toBe('released');
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).rejects.toMatchObject({status:401});
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
});

it('enforces short access lifetime and the original absolute grant expiry across rotations',async()=>{
  const p=await issue({scopes:['mail:read']}),clock=Date.now(),now=vi.spyOn(Date,'now').mockReturnValue(clock+601_000);
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).rejects.toMatchObject({status:401});
  const renewed=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID());
  expect((await authenticateOAuthAccess(bearer(renewed.access_token),ctx.env)).kind).toBe('token');
  expect(await ctx.env.DB.prepare('SELECT expires_at FROM oauth_refresh_tokens WHERE secret_sha256=?').bind(await sha256(renewed.refresh_token)).first('expires_at')).toBe(p.grant.expires_at);
  now.mockReturnValue(p.grant.expires_at-90_000);
  const nearExpiry=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,renewed.refresh_token),crypto.randomUUID());
  expect(nearExpiry.expires_in).toBe(90);
  expect(await ctx.env.DB.prepare('SELECT expires_at FROM oauth_access_tokens WHERE secret_sha256=?').bind(await sha256(nearExpiry.access_token)).first('expires_at')).toBe(p.grant.expires_at);
  expect((await authenticateOAuthAccess(bearer(nearExpiry.access_token),ctx.env)).kind).toBe('token');
  now.mockReturnValue(p.grant.expires_at+1);
  await expect(authenticateOAuthAccess(bearer(nearExpiry.access_token),ctx.env)).rejects.toMatchObject({status:401});
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,nearExpiry.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
});

it('caps issued access duration to the principal expiry and refuses issuance with less than one whole second remaining',async()=>{
  const p=await issue({scopes:['mail:read']}),now=Date.now(),principalExpiry=now+90_500;
  await ctx.env.DB.prepare('UPDATE mailbox_tokens SET expires_at=? WHERE id=?').bind(principalExpiry,p.grant.mailbox_token_id).run();
  const clock=vi.spyOn(Date,'now').mockReturnValue(now);
  const renewed=await exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID());
  expect(renewed.expires_in).toBe(90);
  const stored=await ctx.env.DB.prepare('SELECT expires_at FROM oauth_access_tokens WHERE secret_sha256=?').bind(await sha256(renewed.access_token)).first<number>('expires_at');
  expect(stored).toBe(now+90_000);expect(stored).toBeLessThan(principalExpiry);
  clock.mockReturnValue(principalExpiry-999);
  const before=await count('SELECT count(*) n FROM oauth_access_tokens');
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,renewed.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  expect(await count('SELECT count(*) n FROM oauth_access_tokens')).toBe(before);
  expect(await ctx.env.DB.prepare('SELECT used_at FROM oauth_refresh_tokens WHERE secret_sha256=?').bind(await sha256(renewed.refresh_token)).first('used_at')).toBeNull();
});

it('rechecks client status, mailbox status and the underlying principal on existing access and refresh credentials',async()=>{
  const p=await issue();
  await ctx.env.DB.prepare("UPDATE oauth_clients SET status='disabled' WHERE client_id=?").bind(p.client.client_id).run();
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).rejects.toMatchObject({status:401});
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
  await ctx.env.DB.prepare("UPDATE oauth_clients SET status='active' WHERE client_id=?").bind(p.client.client_id).run();
  let box=await updateMailbox(ctx,p.box.id,{status:'paused',expectedUpdatedAt:p.box.updatedAt});
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).rejects.toMatchObject({status:401});
  box=await updateMailbox(ctx,p.box.id,{status:'active',expectedUpdatedAt:box.updatedAt});
  expect((await authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).kind).toBe('token');
  await revokeToken(ctx,p.box.id,p.grant.mailbox_token_id);
  await expect(authenticateOAuthAccess(bearer(p.tokens.access_token),ctx.env)).rejects.toMatchObject({status:401});
  await expect(exchangeOAuthToken(ctx.env,refreshForm(p.client.client_id,p.tokens.refresh_token),crypto.randomUUID())).rejects.toMatchObject({error:'invalid_grant'});
});
