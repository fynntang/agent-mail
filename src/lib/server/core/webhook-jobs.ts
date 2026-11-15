import {stableId} from './crypto';
import {decryptWebhookSecret,signWebhook,validateWebhookUrl} from './webhook-crypto';
import {webhookPayload,type WebhookEventRow} from './webhooks';
import type {RuntimeEnv} from './types';
import type {AlertNotificationPolicy} from '../../types/alert-notification-policy';
import {alertAdmissionAllowed,alertAdmissionRecorded,alertNotificationAdmission,alertNotificationQuiet,isAlertNotification,loadAlertNotificationPolicy} from './alert-notification-admission';
import {asyncExportAdmissionAllowed,asyncExportAdmissionRecorded,asyncExportNotificationAdmission,isAsyncExportNotification} from './async-export-notification-admission';
import {isRetryBatchNotification,retryBatchAdmissionAllowed,retryBatchAdmissionRecorded,retryBatchNotificationAdmission} from './retry-batch-notification-admission';

const LEASE_MS=120_000,MAX_EVENTS=20,MAX_DELIVERIES=2,MAX_ENDPOINTS=10,MAX_PAYLOAD_BYTES=8*1024;
const encoder=new TextEncoder(),backoff=[60_000,300_000,900_000,3_600_000,14_400_000,43_200_000,86_400_000];
interface Delivery {
  id:string;mailbox_id:string;endpoint_id:string;event_id:string;state:string;attempts:number;attempt_budget:number;
  available_at:number;lease_token:string|null;lease_until:number|null;signed_secret_version:number;signing_secret_ciphertext:string;
  url_snapshot:string;payload_json:string;created_at:number;
}
interface Claim {delivery:Delivery;attemptId:string;token:string}
export interface WebhookJobOptions {
  /** Test-only injection. Production uses strictly-public global fetch, never a service/origin/VPC binding. */
  fetcher?:typeof fetch;
  now?:()=>number;
  timeoutMs?:number;
}
export interface WebhookJobResult {webhookPublished:number;webhookProcessed:number;webhookSucceeded:number;webhookRetried:number;webhookDead:number}
const statement=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
const retryDelay=(attempt:number)=>backoff[Math.min(Math.max(attempt-1,0),backoff.length-1)];
const activeMailbox="EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=e.mailbox_id AND m.status='active')";
const eligibleEndpoint=`w.mailbox_id=e.mailbox_id AND w.status='active' AND w.created_at<=e.created_at AND e.rowid>w.event_after_rowid
  AND(e.type NOT IN('alert_notification.export.succeeded','alert_notification.export.failed','alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation') OR(w.created_at<e.created_at AND w.updated_at<e.created_at))
  AND(e.type NOT IN('alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation') OR EXISTS(
    SELECT 1 FROM async_export_retry_batch_notifications n WHERE n.mailbox_id=e.mailbox_id AND n.event_id=e.id AND EXISTS(
      SELECT 1 FROM json_each(n.endpoint_snapshot_json) j WHERE json_extract(j.value,'$.id')=w.id
        AND json_extract(j.value,'$.version')=w.secret_version AND json_extract(j.value,'$.updatedAt')=w.updated_at)))
  AND EXISTS(SELECT 1 FROM json_each(w.event_types_json) subscription WHERE subscription.value=e.type)`;
// Export outbox projection can lag completion. Require the current subscription configuration
// to predate the terminal fact; same-ms edits and later rotation/configuration changes fail closed.
const policyNotification=(type:string)=>isAlertNotification(type)||isAsyncExportNotification(type)||isRetryBatchNotification(type);

/** Publish and fan out atomically; the event marker is independent of whether any endpoint existed. */
async function publishEvents(env:RuntimeEnv,now:()=>number):Promise<number> {
  const events=await statement(env,`SELECT e.* FROM events e WHERE e.webhook_published_at IS NULL AND ${activeMailbox}
    ORDER BY e.rowid LIMIT ${MAX_EVENTS}`).all<WebhookEventRow>();
  if(!events.results.length)return 0;
  const payloads=new Map<string,string>();
  for(const event of events.results) {
    const payload=webhookPayload(event);
    if(payload!==null&&encoder.encode(payload).byteLength<=MAX_PAYLOAD_BYTES)payloads.set(event.id,payload);
  }
  const safeIds=[...payloads.keys()];
  const endpoints=safeIds.length?await statement(env,`SELECT w.id,e.id event_id FROM webhook_endpoints w JOIN events e ON e.mailbox_id=w.mailbox_id
    WHERE e.id IN(${safeIds.map(()=>'?').join(',')}) AND e.webhook_published_at IS NULL AND ${activeMailbox} AND ${eligibleEndpoint}
    AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id=w.id AND d.event_id=e.id)
    ORDER BY e.created_at,e.id,w.created_at,w.id LIMIT ${MAX_EVENTS*MAX_ENDPOINTS}`,...safeIds).all<{id:string;event_id:string}>():{results:[]};
  const batch:D1PreparedStatement[]=[],markers:number[]=[],policies=new Map<string,AlertNotificationPolicy>();
  for(const event of events.results) {
    const payload=payloads.get(event.id),at=now();
    const alert=payload!==undefined&&isAlertNotification(event.type),exportNotice=payload!==undefined&&isAsyncExportNotification(event.type),batchNotice=payload!==undefined&&isRetryBatchNotification(event.type),policyNotice=alert||exportNotice||batchNotice;
    const allowed=batchNotice?retryBatchAdmissionAllowed:exportNotice?asyncExportAdmissionAllowed:alertAdmissionAllowed,recorded=batchNotice?retryBatchAdmissionRecorded:exportNotice?asyncExportAdmissionRecorded:alertAdmissionRecorded;
    const admission=policyNotice?` AND ${allowed}`:'';
    if(policyNotice){
      let policy=policies.get(event.mailbox_id);if(!policy){policy=await loadAlertNotificationPolicy(env,event.mailbox_id);policies.set(event.mailbox_id,policy);}
      batch.push(...(batchNotice?retryBatchNotificationAdmission:exportNotice?asyncExportNotificationAdmission:alertNotificationAdmission)(env,event,payload!,policy,at,eligibleEndpoint));
    }
    for(const endpoint of endpoints.results.filter(row=>row.event_id===event.id))batch.push(statement(env,`INSERT INTO webhook_deliveries
      (id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at)
      SELECT ?,e.mailbox_id,w.id,e.id,'pending',0,?,w.secret_version,w.signing_secret_ciphertext,w.url,?,?,?
      FROM webhook_endpoints w JOIN events e ON e.mailbox_id=w.mailbox_id
      WHERE w.id=? AND e.id=? AND e.mailbox_id=? AND e.webhook_published_at IS NULL AND ${activeMailbox} AND ${eligibleEndpoint}${admission}
      ON CONFLICT(endpoint_id,event_id) DO NOTHING`,await stableId(`webhook-delivery:v1:${endpoint.id}:${event.id}`),at,payload!,at,at,endpoint.id,event.id,event.mailbox_id));
    // Recheck missing endpoints inside the transaction, including a same-ms endpoint created
    // after JS preselection. Leave that event unpublished so the next bounded pass completes it.
    markers.push(batch.length);
    batch.push(statement(env,`UPDATE events AS e SET webhook_published_at=? WHERE e.id=? AND e.mailbox_id=?
      AND e.webhook_published_at IS NULL AND ${activeMailbox}${policyNotice?` AND ${recorded}`:''}${payload!==undefined?` AND ${policyNotice?`(NOT(${allowed}) OR `:''}NOT EXISTS(SELECT 1 FROM webhook_endpoints w WHERE ${eligibleEndpoint}
        AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id=w.id AND d.event_id=e.id))${policyNotice?')':''}`:''}`,at,event.id,event.mailbox_id));
  }
  const result=await env.DB.batch(batch);
  return markers.reduce((total,index)=>total+result[index].meta.changes,0);
}

/** A cancelled/replaced lease can finish its history, but can never change the delivery again. */
async function closeLostAttempts(env:RuntimeEnv,at:number):Promise<void> {
  await statement(env,`UPDATE webhook_delivery_attempts SET outcome='expired',error_code='lease_lost',finished_at=?
    WHERE id IN(SELECT a.id FROM webhook_delivery_attempts a WHERE a.outcome='started' AND NOT EXISTS(
      SELECT 1 FROM webhook_deliveries d WHERE d.id=a.delivery_id AND d.mailbox_id=a.mailbox_id AND d.state='running'
      AND d.lease_token=a.lease_token AND d.lease_until>?) ORDER BY a.started_at,a.id LIMIT 20)`,at,at).run();
}
async function recoverExpired(env:RuntimeEnv,at:number):Promise<void> {
  const expired=await statement(env,"SELECT * FROM webhook_deliveries WHERE state='running' AND lease_until<=? ORDER BY lease_until,id LIMIT 20",at).all<Delivery>();
  const batch:D1PreparedStatement[]=[];
  for(const delivery of expired.results) {
    const dead=delivery.attempts>=delivery.attempt_budget;
    batch.push(
      statement(env,`UPDATE webhook_deliveries SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,last_error_code='lease_expired',
        completed_at=?,updated_at=? WHERE id=? AND mailbox_id=? AND state='running' AND lease_token=? AND lease_until<=?`,
        dead?'dead':'pending',at+retryDelay(delivery.attempts),dead?at:null,at,delivery.id,delivery.mailbox_id,delivery.lease_token,at),
      statement(env,`UPDATE webhook_delivery_attempts SET outcome='expired',error_code='lease_expired',finished_at=?
        WHERE delivery_id=? AND mailbox_id=? AND lease_token=? AND outcome='started' AND NOT EXISTS(
          SELECT 1 FROM webhook_deliveries d WHERE d.id=? AND d.mailbox_id=? AND d.state='running' AND d.lease_token=? AND d.lease_until>?)`,
        at,delivery.id,delivery.mailbox_id,delivery.lease_token,delivery.id,delivery.mailbox_id,delivery.lease_token,at)
    );
  }
  if(batch.length)await env.DB.batch(batch);
  await closeLostAttempts(env,at);
}
async function claimDelivery(env:RuntimeEnv,id:string,at:number,policyVersion?:number):Promise<Claim|null> {
  const token=crypto.randomUUID(),attemptId=crypto.randomUUID();
  const result=await env.DB.batch([
    statement(env,`UPDATE webhook_deliveries SET state='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
      WHERE id=? AND state='pending' AND available_at<=? AND attempts<attempt_budget AND attempt_budget<=80
      AND EXISTS(SELECT 1 FROM webhook_endpoints w JOIN mailboxes m ON m.id=w.mailbox_id
        WHERE w.id=webhook_deliveries.endpoint_id AND w.mailbox_id=webhook_deliveries.mailbox_id AND w.status='active' AND m.status='active')
      ${policyVersion===undefined?'':'AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=webhook_deliveries.mailbox_id),0)=?'}`,
      token,at+LEASE_MS,at,id,at,...(policyVersion===undefined?[]:[policyVersion])),
    statement(env,`INSERT INTO webhook_delivery_attempts(id,mailbox_id,delivery_id,attempt_no,lease_token,outcome,started_at)
      SELECT ?,mailbox_id,id,attempts,?,'started',? FROM webhook_deliveries WHERE id=? AND state='running' AND lease_token=?`,attemptId,token,at,id,token),
    statement(env,"SELECT * FROM webhook_deliveries WHERE id=? AND state='running' AND lease_token=?",id,token)
  ]);
  const delivery=(result[2] as D1Result<Delivery>).results[0];
  return result[0].meta.changes===1&&delivery?{delivery,attemptId,token}:null;
}

function notificationBlock(policy:AlertNotificationPolicy,type:string,at:number):string|null{
  if(!policy.enabled)return 'alert_notifications_disabled';
  if(type==='cloudflare.suppression.alert.resolved'&&!policy.recoveryEnabled)return 'alert_recovery_disabled';
  return alertNotificationQuiet(policy,at)?'alert_quiet_hours':null;
}
/** Hold quiet deliveries before claiming a transport attempt. Live switches cancel instead of accumulating a backlog. */
async function pendingNotificationPolicy(env:RuntimeEnv,d:Delivery,at:number):Promise<number|false|undefined>{
  const type=JSON.parse(d.payload_json).type;if(!policyNotification(type))return undefined;
  const policy=await loadAlertNotificationPolicy(env,d.mailbox_id),block=notificationBlock(policy,type,at);if(!block)return policy.version;
  const quiet=block==='alert_quiet_hours';
  await statement(env,`UPDATE webhook_deliveries SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,last_error_code=?,completed_at=?,updated_at=MAX(updated_at,?)
    WHERE id=? AND mailbox_id=? AND state='pending' AND available_at<=?
    AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=webhook_deliveries.mailbox_id),0)=?`,
    quiet?'pending':'cancelled',quiet?at+60_000:d.available_at,block,quiet?null:at,at,d.id,d.mailbox_id,at,policy.version).run();
  return false;
}

async function settle(env:RuntimeEnv,claim:Claim,at:number,outcome:'succeeded'|'retry'|'dead',code:string|null,httpStatus:number|null,delay=0,
  cancelled=false):Promise<'succeeded'|'retry'|'dead'|null> {
  const d=claim.delivery;
  if(outcome==='retry'&&d.attempts>=d.attempt_budget)outcome='dead';
  const state=cancelled?'cancelled':outcome==='retry'?'pending':outcome;
  const live="id=? AND mailbox_id=? AND state='running' AND lease_token=? AND lease_until>? AND attempts=?";
  const args=[d.id,d.mailbox_id,claim.token,at,d.attempts] as const;
  const results=await env.DB.batch([
    statement(env,`UPDATE webhook_delivery_attempts SET outcome=?,http_status=?,error_code=?,finished_at=? WHERE id=? AND lease_token=? AND outcome='started'
      AND EXISTS(SELECT 1 FROM webhook_deliveries WHERE ${live})`,outcome,httpStatus,code,at,claim.attemptId,claim.token,...args),
    statement(env,`UPDATE webhook_deliveries SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,last_http_status=?,last_error_code=?,completed_at=?,updated_at=?
      WHERE ${live} AND EXISTS(SELECT 1 FROM webhook_delivery_attempts WHERE id=? AND lease_token=? AND outcome=? AND finished_at=?)`,
      state,outcome==='retry'?at+Math.max(retryDelay(d.attempts),delay):d.available_at,httpStatus,code,outcome==='retry'?null:at,at,...args,claim.attemptId,claim.token,outcome,at)
  ]);
  return results[1].meta.changes===1?outcome:null;
}
function retryAfter(value:string|null,at:number):number {
  if(value===null)return 0;
  const seconds=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-at;
  return Number.isFinite(seconds)?Math.max(0,Math.min(seconds,86_400_000)):0;
}
function cancel(response:Response):void {void response.body?.cancel().catch(()=>{});}
async function post(fetcher:typeof fetch,url:string,body:string,headers:Record<string,string>,timeoutMs:number):Promise<Response> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      fetcher(url,{method:'POST',redirect:'manual',cache:'no-store',headers,body,signal:controller.signal}).then(response=>{
        if(controller.signal.aborted){cancel(response);throw new Error('delivery_timeout');}return response;
      }),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('delivery_timeout'));},timeoutMs);})
    ]);
  }finally {clearTimeout(timer!);controller.abort();}
}

/** At-least-once signed delivery. The receiver deduplicates by stable event/delivery IDs. */
export async function runWebhookJobs(env:RuntimeEnv,options:WebhookJobOptions={}):Promise<WebhookJobResult> {
  const now=options.now??Date.now,fetcher=options.fetcher??fetch;
  const result:WebhookJobResult={webhookPublished:0,webhookProcessed:0,webhookSucceeded:0,webhookRetried:0,webhookDead:0};
  result.webhookPublished=await publishEvents(env,now);await recoverExpired(env,now());
  const pending=await statement(env,`SELECT d.* FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id
    JOIN mailboxes m ON m.id=d.mailbox_id WHERE d.state='pending' AND d.available_at<=? AND d.attempts<d.attempt_budget AND d.attempt_budget<=80
    AND w.status='active' AND m.status='active' ORDER BY d.available_at,d.id LIMIT ${MAX_EVENTS}`,now()).all<Delivery>();
  const record=(outcome:'succeeded'|'retry'|'dead'|null)=>{if(outcome==='succeeded')result.webhookSucceeded++;else if(outcome==='retry')result.webhookRetried++;else if(outcome==='dead')result.webhookDead++;};
  for(const candidate of pending.results) {
    if(result.webhookProcessed>=MAX_DELIVERIES)break;
    const policyVersion=await pendingNotificationPolicy(env,candidate,now());if(policyVersion===false)continue;
    const claim=await claimDelivery(env,candidate.id,now(),policyVersion);if(!claim)continue;result.webhookProcessed++;
    const d=claim.delivery;
    let target:string,signature:string;
    try{target=validateWebhookUrl(env,d.url_snapshot);}catch{record(await settle(env,claim,now(),'dead','invalid_target',null));continue;}
    const event=await statement(env,'SELECT * FROM events WHERE id=? AND mailbox_id=?',d.event_id,d.mailbox_id).first<WebhookEventRow>();
    const expected=event?webhookPayload(event):null;
    if(!expected||expected!==d.payload_json||encoder.encode(d.payload_json).byteLength>MAX_PAYLOAD_BYTES){record(await settle(env,claim,now(),'dead','payload_unavailable',null));continue;}
    const timestamp=String(Math.floor(now()/1000));
    try{
      const secret=await decryptWebhookSecret(env,d.mailbox_id,d.endpoint_id,d.signed_secret_version,d.signing_secret_ciphertext);
      signature=await signWebhook(secret,timestamp,d.id,d.payload_json);
    }
    catch{record(await settle(env,claim,now(),'retry','signing_key_unavailable',null));continue;}
    let livePolicy:AlertNotificationPolicy|undefined;
    if(policyNotification(event!.type)){
      livePolicy=await loadAlertNotificationPolicy(env,d.mailbox_id);const block=notificationBlock(livePolicy,event!.type,now());
      if(block){record(await settle(env,claim,now(),block==='alert_quiet_hours'?'retry':'dead',block,null,60_000,block!=='alert_quiet_hours'));continue;}
    }
    const authorization=await statement(env,`SELECT m.status mailbox_status,w.status endpoint_status FROM webhook_deliveries d
      JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id JOIN mailboxes m ON m.id=d.mailbox_id
      WHERE d.id=? AND d.mailbox_id=? AND d.state='running' AND d.lease_token=? AND d.lease_until>?
      ${livePolicy?'AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=d.mailbox_id),0)=?':''}`,d.id,d.mailbox_id,claim.token,now(),...(livePolicy?[livePolicy.version]:[]))
      .first<{mailbox_status:string;endpoint_status:string}>();
    if(!authorization)continue;
    if(authorization.endpoint_status!=='active'||authorization.mailbox_status!=='active'){
      const paused=authorization.endpoint_status==='active'&&authorization.mailbox_status==='paused';
      record(await settle(env,claim,now(),paused?'retry':'dead',paused?'mailbox_inactive':'endpoint_inactive',null,0,!paused));continue;
    }
    try {
      const response=await post(fetcher,target,d.payload_json,{'Content-Type':'application/json','X-Agent-Mail-Event':event!.type,
        'X-Agent-Mail-Delivery':d.id,'X-Agent-Mail-Attempt':String(d.attempts),'X-Agent-Mail-Secret-Version':String(d.signed_secret_version),
        'X-Agent-Mail-Signature':`t=${timestamp},v1=${signature}`},options.timeoutMs??10_000);
      const status=response.status,delay=retryAfter(response.headers.get('Retry-After'),now());cancel(response);
      if(!Number.isInteger(status)||status<100||status>599)throw new Error('invalid_http_status');
      if(status>=200&&status<=299)record(await settle(env,claim,now(),'succeeded',null,status));
      else if(status===408||status===429||status>=500)record(await settle(env,claim,now(),'retry','http_retry',status,delay));
      else record(await settle(env,claim,now(),'dead','http_rejected',status));
    }catch(error){record(await settle(env,claim,now(),'retry',error instanceof Error&&error.message==='delivery_timeout'?'delivery_timeout':'network_error',null));}
  }
  await closeLostAttempts(env,now());
  return result;
}
