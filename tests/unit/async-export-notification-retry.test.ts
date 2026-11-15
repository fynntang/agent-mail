import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,issueToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {createWebhookEndpoint,retryWebhookDelivery,rotateWebhookSecret} from '../../src/lib/server/core/webhooks';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {retryAsyncExportNotificationDelivery,asyncExportNotificationRetryEligibility,asyncExportNotificationSecretAvailable,asyncExportNotificationTargetValid} from '../../src/lib/server/core/async-export-notification-retry';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,env:RuntimeEnv,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'export-notification-retry'},r2Buckets:{MAIL_BLOBS:'export-notification-retry'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Retry notices',localPart:`retry-${crypto.randomUUID()}`});
async function policy(id:string,changes:Record<string,unknown>){const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,id)).policy;return updateAlertNotificationPolicy(ctx,id,{...fields,...changes,expectedVersion:version});}
async function fixture(corruptKey=false){
  const mailbox=await box(),hook=await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/notify',eventTypes:['alert_notification.export.succeeded','alert_notification.export.failed']});at++;
  if(corruptKey){const envelope=JSON.parse(await env.DB.prepare('SELECT signing_secret_ciphertext FROM webhook_endpoints WHERE id=?').bind(hook.endpoint.id).first<string>('signing_secret_ciphertext') as string);
    envelope.data=(envelope.data[0]==='A'?'B':'A')+envelope.data.slice(1);await env.DB.prepare('UPDATE webhook_endpoints SET signing_secret_ciphertext=? WHERE id=?').bind(JSON.stringify(envelope),hook.endpoint.id).run();}
  const job=(await createAsyncAlertNotificationExport(ctx,mailbox.id,{format:'json',clientRequestId:crypto.randomUUID()})).job;
  await env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='fixture',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,job.id).run();
  await env.DB.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,job.id).run();
  await projectAsyncExportNotifications(env,{now:()=>at});await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  if(corruptKey)await env.DB.prepare("UPDATE webhook_deliveries SET state='dead',lease_token=NULL,lease_until=NULL WHERE mailbox_id=?").bind(mailbox.id).run();
  const delivery=await env.DB.prepare('SELECT * FROM webhook_deliveries WHERE mailbox_id=?').bind(mailbox.id).first<Record<string,unknown>>();expect(delivery?.state).toBe('dead');
  return {box:mailbox,hook,job,delivery:delivery!};
}
const input=(version:number)=>({clientRequestId:crypto.randomUUID(),expectedUpdatedAt:version});
const raw=(id:string)=>env.DB.prepare('SELECT * FROM webhook_deliveries WHERE id=?').bind(id).first<Record<string,unknown>>();
const retries=()=>env.DB.prepare("SELECT * FROM audit_events WHERE action='webhook.delivery_retried'").all<Record<string,unknown>>();

it('requeues the same frozen delivery once, signs with its old key and preserves attempts and admission through a secret rotation',async()=>{
  const f=await fixture();await rotateWebhookSecret(ctx,f.box.id,f.hook.endpoint.id,{expectedUpdatedAt:f.hook.endpoint.updatedAt});
  const request=input(Number(f.delivery.updated_at)),result=await retryAsyncExportNotificationDelivery(ctx,f.box.id,f.job.id,String(f.delivery.id),request);
  expect(result).toMatchObject({delivery:{id:f.delivery.id,state:'pending',attempts:1,attemptBudget:16,secretVersion:1},manualRetry:{clientRequestId:request.clientRequestId,previousAttemptBudget:8,attemptBudget:16},replayed:false});
  expect(result.delivery.updatedAt).toBeGreaterThan(request.expectedUpdatedAt);const after=(await raw(String(f.delivery.id)))!;
  for(const name of ['payload_json','url_snapshot','signing_secret_ciphertext','signed_secret_version','attempts'])expect(after[name]).toBe(f.delivery[name]);
  const fetched:Request[]=[];at=Number(after.available_at);await runWebhookJobs(env,{now:()=>at,fetcher:async(input,init)=>{fetched.push(new Request(input,init));return new Response(null,{status:204});}});
  expect(fetched).toHaveLength(1);const body=await fetched[0].text(),signature=fetched[0].headers.get('X-Agent-Mail-Signature')!,timestamp=signature.match(/^t=(\d+),/)![1];
  expect(signature).toBe(`t=${timestamp},v1=${createHmac('sha256',f.hook.secret).update(`${timestamp}.${f.delivery.id}.${body}`).digest('hex')}`);
  expect(fetched[0].headers.get('X-Agent-Mail-Delivery')).toBe(f.delivery.id);expect(fetched[0].headers.get('X-Agent-Mail-Attempt')).toBe('2');expect(body).toBe(f.delivery.payload_json);
  expect((await raw(String(f.delivery.id)))?.state).toBe('succeeded');expect((await retries()).results).toHaveLength(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM async_export_notification_state').first('n')).toBe(1);expect(JSON.stringify(result)).not.toMatch(/url_snapshot|signing_secret|claim_token|lease_token|https:/);
});

it('replays a committed UUID after a lost ACK or a later dead outcome without granting another attempt budget',async()=>{
  const f=await fixture(),request=input(Number(f.delivery.updated_at));let injected=false;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!injected){injected=true;throw Error('PRIVATE_LOST_ACK');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const first=await retryAsyncExportNotificationDelivery({...ctx,env:{...env,DB:database}},f.box.id,f.job.id,String(f.delivery.id),request);expect(first.replayed).toBe(true);expect(first.delivery.attemptBudget).toBe(16);
  at=first.delivery.availableAt;await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  const duplicate=await retryAsyncExportNotificationDelivery(ctx,f.box.id,f.job.id,String(f.delivery.id),request);expect(duplicate).toMatchObject({replayed:true,delivery:{state:'dead',attemptBudget:16}});
  expect((await retries()).results).toHaveLength(1);await expect(retryAsyncExportNotificationDelivery(ctx,f.box.id,f.job.id,String(f.delivery.id),{...request,expectedUpdatedAt:duplicate.delivery.updatedAt})).rejects.toMatchObject({code:'export_notification_retry_conflict'});
  const missingKey={...ctx,env:{...env,WEBHOOK_KEYRING:undefined}};expect((await retryAsyncExportNotificationDelivery(missingKey,f.box.id,f.job.id,String(f.delivery.id),request)).replayed).toBe(true);
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.box.id).run();
  expect((await retryWebhookDelivery(missingKey,f.box.id,String(f.delivery.id),request) as {replayed:boolean}).replayed).toBe(true);
  await expect(retryWebhookDelivery(ctx,f.box.id,String(f.delivery.id),input(duplicate.delivery.updatedAt))).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
});

it('concurrent UUIDs competing for one delivery version commit one receipt and one budget increase',async()=>{
  const f=await fixture(),version=Number(f.delivery.updated_at),results=await Promise.allSettled([
    retryAsyncExportNotificationDelivery(ctx,f.box.id,f.job.id,String(f.delivery.id),input(version)),retryAsyncExportNotificationDelivery(ctx,f.box.id,f.job.id,String(f.delivery.id),input(version))
  ]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await retries()).results).toHaveLength(1);expect((await raw(String(f.delivery.id)))?.attempt_budget).toBe(16);
  const g=await fixture(),request=input(Number(g.delivery.updated_at)),duplicates=await Promise.all([retryAsyncExportNotificationDelivery(ctx,g.box.id,g.job.id,String(g.delivery.id),request),retryAsyncExportNotificationDelivery(ctx,g.box.id,g.job.id,String(g.delivery.id),request)]);
  expect(duplicates.map(result=>result.replayed).sort()).toEqual([false,true]);expect((await retries()).results).toHaveLength(2);
});

it('blocks disabled, quiet, paused, inactive endpoint and exhausted budget without creating retries or issuing HTTP',async()=>{
  const f=await fixture(),request=input(Number(f.delivery.updated_at)),invoke=(target=ctx)=>retryAsyncExportNotificationDelivery(target,f.box.id,f.job.id,String(f.delivery.id),request);
  await policy(f.box.id,{enabled:false});await expect(invoke()).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  const minute=new Date(at).getUTCHours()*60+new Date(at).getUTCMinutes();await policy(f.box.id,{enabled:true,quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'});await expect(invoke()).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  await policy(f.box.id,{quietEnabled:false,recoveryEnabled:false});await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.box.id).run();await expect(invoke()).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  await env.DB.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(f.box.id).run();await env.DB.prepare("UPDATE webhook_endpoints SET status='paused' WHERE id=?").bind(f.hook.endpoint.id).run();await expect(invoke()).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  await env.DB.prepare("UPDATE webhook_endpoints SET status='active' WHERE id=?").bind(f.hook.endpoint.id).run();await env.DB.prepare('UPDATE webhook_deliveries SET attempt_budget=80 WHERE id=?').bind(f.delivery.id).run();await expect(invoke()).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  expect((await retries()).results).toHaveLength(0);
});

it('fences a policy change between eligibility and the retry transaction without writing an audit receipt',async()=>{
  const f=await fixture();let changed=false;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await policy(f.box.id,{enabled:false});}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await expect(retryAsyncExportNotificationDelivery({...ctx,env:{...env,DB:database}},f.box.id,f.job.id,String(f.delivery.id),input(Number(f.delivery.updated_at)))).rejects.toMatchObject({code:'export_notification_retry_changed'});
  expect((await retries()).results).toHaveLength(0);expect((await raw(String(f.delivery.id)))?.state).toBe('dead');
});

it('denies wrong mailbox/job, anonymous/Token access and malformed intents; generic retries cannot bypass the export checks',async()=>{
  const f=await fixture(),other=await box(),request=input(Number(f.delivery.updated_at)),id=String(f.delivery.id);
  await expect(retryAsyncExportNotificationDelivery(ctx,other.id,f.job.id,id,request)).rejects.toMatchObject({status:404});await expect(retryAsyncExportNotificationDelivery(ctx,f.box.id,crypto.randomUUID(),id,request)).rejects.toMatchObject({status:404});
  const issued=await issueToken(ctx,f.box.id,{name:'Denied',scopes:['mail:read']}),actor={kind:'token' as const,mailboxId:f.box.id,tokenId:issued.token.id,canRead:true};
  for(const current of [{...ctx,actor:null},{...ctx,actor}])await expect(retryAsyncExportNotificationDelivery(current,f.box.id,f.job.id,id,request)).rejects.toMatchObject({status:current.actor?403:401});
  for(const invalid of [{},{...request,clientRequestId:'invalid'},{...request,expectedUpdatedAt:-1},{...request,extra:'PRIVATE'}])await expect(retryAsyncExportNotificationDelivery(ctx,f.box.id,f.job.id,id,invalid)).rejects.toMatchObject({code:'invalid_input'});
  await expect(retryWebhookDelivery(ctx,f.box.id,id,{})).rejects.toMatchObject({code:'invalid_input'});await policy(f.box.id,{enabled:false});await expect(retryWebhookDelivery(ctx,f.box.id,id,request)).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  await policy(f.box.id,{enabled:true});expect((await retryWebhookDelivery(ctx,f.box.id,id,request)).delivery.state).toBe('pending');expect((await retries()).results).toHaveLength(1);
});

it('checks key availability and target structure without decrypting during capability reads',async()=>{
  const f=await fixture(),p=(await getAlertNotificationPolicy(ctx,f.box.id)).policy;
  const capability={mailboxStatus:'active',endpointStatus:'active',notificationDecision:'allowed',deliveryState:'dead',attemptBudget:8,payloadValid:true,secretAvailable:true,targetValid:true};
  expect(asyncExportNotificationRetryEligibility(env,capability,p,at)).toEqual({available:true,reason:null});
  for(const [override,reason] of [[{notificationDecision:'disabled'},'not_admitted'],[{deliveryState:'cancelled'},'not_dead'],[{payloadValid:false},'payload_unavailable'],[{secretAvailable:false},'signing_key_unavailable'],[{targetValid:false},'invalid_target']] as const)expect(asyncExportNotificationRetryEligibility(env,{...capability,...override},p,at).reason).toBe(reason);
  expect(asyncExportNotificationSecretAvailable(env,String(f.delivery.signing_secret_ciphertext))).toBe(true);expect(asyncExportNotificationSecretAvailable(env,'{"v":1,"kid":"other","iv":"private","data":"private"}')).toBe(false);
  expect(asyncExportNotificationTargetValid(env,'https://hooks.example.net/path')).toBe(true);expect(asyncExportNotificationTargetValid(env,'https://127.0.0.1/private')).toBe(false);
  await expect(retryAsyncExportNotificationDelivery({...ctx,env:{...env,WEBHOOK_KEYRING:undefined}},f.box.id,f.job.id,String(f.delivery.id),input(Number(f.delivery.updated_at)))).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
});

it('authenticates frozen ciphertext on POST and caps the final manual retry budget at80',async()=>{
  const broken=await fixture(true);expect(asyncExportNotificationSecretAvailable(env,String(broken.delivery.signing_secret_ciphertext))).toBe(true);
  await expect(retryAsyncExportNotificationDelivery(ctx,broken.box.id,broken.job.id,String(broken.delivery.id),input(Number(broken.delivery.updated_at)))).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  expect((await retries()).results).toHaveLength(0);
  const final=await fixture();await env.DB.prepare('UPDATE webhook_deliveries SET attempt_budget=79 WHERE id=?').bind(final.delivery.id).run();
  const result=await retryAsyncExportNotificationDelivery(ctx,final.box.id,final.job.id,String(final.delivery.id),input(Number(final.delivery.updated_at)));
  expect(result).toMatchObject({delivery:{attemptBudget:80},manualRetry:{previousAttemptBudget:79,attemptBudget:80}});expect((await retries()).results).toHaveLength(1);
});

it('generic retry classifies exports by the real notification receipt even when the frozen payload pretends to be an ordinary event',async()=>{
  const f=await fixture(),another=await createWebhookEndpoint(ctx,f.box.id,{url:'https://hooks.example.net/another',eventTypes:['message.received']}),forged=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,
    url_snapshot,payload_json,last_http_status,last_error_code,completed_at,created_at,updated_at,attempt_budget)
    SELECT ?,d.mailbox_id,w.id,d.event_id,'dead',1,d.available_at,w.secret_version,w.signing_secret_ciphertext,w.url,?,400,'http_rejected',d.completed_at,d.created_at,d.updated_at,8
    FROM webhook_deliveries d JOIN webhook_endpoints w ON w.mailbox_id=d.mailbox_id WHERE d.id=? AND w.id=?`)
    .bind(forged,JSON.stringify({v:1,type:'message.received',data:{messageId:crypto.randomUUID()}}),f.delivery.id,another.endpoint.id).run();
  await expect(retryWebhookDelivery(ctx,f.box.id,forged,input(Number(f.delivery.updated_at)))).rejects.toMatchObject({code:'export_notification_retry_unavailable'});
  await expect(retryWebhookDelivery(ctx,f.box.id,forged,{})).rejects.toMatchObject({code:'invalid_input'});
  expect((await raw(forged))).toMatchObject({state:'dead',attempt_budget:8});expect((await retries()).results).toHaveLength(0);
});
