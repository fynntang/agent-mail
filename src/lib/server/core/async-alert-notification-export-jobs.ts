import type {AlertNotificationExport} from '../../types/alert-notification-export';
import type {AlertNotificationDeliverySummary} from '../../types/alert-notification-decisions';
import {ALERT_NOTIFICATION_DECISIONS,notificationDecisionSelect,notificationDecisionDto,notificationDeliveryDto,emptyNotificationDeliverySummary,
  type NotificationDecisionRow,type NotificationDeliveryRow} from './alert-notification-decisions';
import {parseAsyncAlertNotificationExportSummary,type AsyncAlertNotificationExportRow} from './async-alert-notification-exports';
import {formatAsyncExportChunk} from './async-alert-notification-export-format';
import {sha256} from './crypto';
import {ServiceError,type RuntimeEnv} from './types';

const LEASE_MS=120_000,MAX_FAILURES=5,MAX_DECISIONS=100_000,MAX_DELIVERIES=1_000_000;
const MAX_FRAGMENT_BYTES=8*1024*1024,MAX_BODY_BYTES=256*1024*1024-64*1024;
export interface AsyncAlertNotificationExportJobOptions{now?:()=>number;batchSize?:number;maxBatches?:number}
export interface AsyncAlertNotificationExportJobResult{
  asyncExportsProcessed:number;asyncExportsCompleted:number;asyncExportsFailed:number;asyncExportsExpired:number;asyncExportsCleaned:number;
}
type ExportItem=AlertNotificationExport['decisions'][number];
const statement=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
export const asyncAlertNotificationExportPrefix=(box:string,id:string)=>`exports/alert-notification/${box}/${id}/`;
const activeMailbox="EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=async_alert_notification_exports.mailbox_id AND m.status IN('active','paused'))";
function live(job:AsyncAlertNotificationExportRow,at:number){return {sql:"id=? AND mailbox_id=? AND state='running' AND lease_token=? AND lease_until>? AND expires_at>? AND version=?",
  args:[job.id,job.mailbox_id,job.lease_token,at,at,job.version] as const};}

async function expireAndRecover(env:RuntimeEnv,at:number,result:AsyncAlertNotificationExportJobResult):Promise<void>{
  const expired=await statement(env,`UPDATE async_alert_notification_exports SET state='expired',lease_token=NULL,lease_until=NULL,error_code='async_export_expired',
    completed_at=COALESCE(completed_at,?),updated_at=MAX(updated_at+1,?),version=version+1,cleanup_due_at=?
    WHERE id IN(SELECT id FROM async_alert_notification_exports WHERE state IN('queued','running','succeeded') AND expires_at<=? ORDER BY expires_at,id LIMIT 20) RETURNING id`,at,at,at,at).all<{id:string}>();
  result.asyncExportsExpired+=expired.results.length;
  await statement(env,`UPDATE async_alert_notification_exports SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code='async_export_source_changed',
    completed_at=?,updated_at=MAX(updated_at+1,?),version=version+1,cleanup_due_at=?
    WHERE id IN(SELECT x.id FROM async_alert_notification_exports x JOIN mailboxes m ON m.id=x.mailbox_id WHERE x.state IN('queued','running') AND m.status NOT IN('active','paused') ORDER BY x.created_at,x.id LIMIT 20)`,at,at,at).run();
  const interrupted=(await statement(env,`SELECT * FROM async_alert_notification_exports WHERE state='running' AND lease_until<=? AND expires_at>? ORDER BY lease_until,id LIMIT 20`,at,at)
    .all<AsyncAlertNotificationExportRow>()).results;
  for(const job of interrupted){
    const failed=job.failures+1>=MAX_FAILURES;
    const changed=await statement(env,`UPDATE async_alert_notification_exports SET state=?,lease_token=NULL,lease_until=NULL,failures=failures+1,error_code='async_export_lease_expired',
      available_at=?,completed_at=?,updated_at=MAX(updated_at+1,?),version=version+1,cleanup_due_at=CASE WHEN ?=1 THEN ? ELSE cleanup_due_at END
      WHERE id=? AND state='running' AND lease_token=? AND lease_until<=? AND expires_at>? AND version=? RETURNING id`,failed?'failed':'queued',at,failed?at:null,at,failed?1:0,at,job.id,job.lease_token,at,at,job.version).all<{id:string}>();
    if(failed)result.asyncExportsFailed+=changed.results.length;
  }
}

async function claim(env:RuntimeEnv,at:number):Promise<AsyncAlertNotificationExportRow|null>{
  const token=crypto.randomUUID();
  return statement(env,`UPDATE async_alert_notification_exports SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,
    started_at=COALESCE(started_at,?),updated_at=MAX(updated_at+1,?),version=version+1
    WHERE id=(SELECT id FROM async_alert_notification_exports WHERE state='queued' AND available_at<=? AND expires_at>? AND failures<? AND ${activeMailbox}
      ORDER BY available_at,updated_at,id LIMIT 1) AND state='queued' RETURNING *`,token,at+LEASE_MS,at,at,at,at,MAX_FAILURES).first<AsyncAlertNotificationExportRow>();
}

function rowFilter(job:AsyncAlertNotificationExportRow):{where:string;args:(string|number)[]}{
  const cursor=job.next_time!==null?' AND(n.decided_at<? OR(n.decided_at=? AND n.event_id<?))':'';
  return {where:`n.mailbox_id=? AND n.rowid<=? AND n.decided_at>=? AND n.decided_at<?${job.filter_decision==='all'?'':' AND n.decision=?'}${job.filter_event_type==='all'?'':' AND e.type=?'}${cursor}`,
    args:[job.mailbox_id,job.decision_watermark,job.from_ms,job.to_ms,...(job.filter_decision==='all'?[]:[job.filter_decision]),
      ...(job.filter_event_type==='all'?[]:[`cloudflare.suppression.alert.${job.filter_event_type}`]),...(job.next_time===null?[]:[job.next_time,job.next_time,job.next_event_id!])]};
}
function addDelivery(summary:AlertNotificationDeliverySummary,row:NotificationDeliveryRow):void{
  summary.total++;summary[row.state]++;summary.attempts+=row.attempts;
  if(row.state==='pending'&&row.last_error_code==='alert_quiet_hours')summary.quietDeferred++;
}
async function readBatch(env:RuntimeEnv,job:AsyncAlertNotificationExportRow,limit:number):Promise<{rows:NotificationDecisionRow[];items:ExportItem[];summary:AlertNotificationExport['summary']}>{
  const filter=rowFilter(job),page=`${notificationDecisionSelect} WHERE ${filter.where} ORDER BY n.decided_at DESC,n.event_id DESC LIMIT ?`;
  const result=await env.DB.batch([
    statement(env,page,...filter.args,limit),
    statement(env,`SELECT id,mailbox_id,endpoint_id,event_id,state,attempts,attempt_budget,available_at,last_http_status,last_error_code,
      signed_secret_version,created_at,updated_at,completed_at FROM webhook_deliveries WHERE mailbox_id=? AND event_id IN(
        SELECT n.event_id FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id
        WHERE ${filter.where} ORDER BY n.decided_at DESC,n.event_id DESC LIMIT ?) ORDER BY event_id,created_at DESC,id DESC LIMIT 5001`,job.mailbox_id,...filter.args,limit)
  ]);
  const rows=result[0].results as unknown as NotificationDecisionRow[],deliveries=result[1].results as unknown as NotificationDeliveryRow[];
  if(deliveries.length>5000)throw new ServiceError('async_export_batch_too_large',413);
  if(job.processed_decisions+rows.length>job.total_decisions||!rows.length&&job.processed_decisions!==job.total_decisions)throw new ServiceError('async_export_source_changed',409);
  const byDecision=Object.fromEntries(ALERT_NOTIFICATION_DECISIONS.map(reason=>[reason,0])) as AlertNotificationExport['summary']['byDecision'];
  const summary:AlertNotificationExport['summary']={total:rows.length,allowed:0,skipped:0,byDecision,delivery:emptyNotificationDeliverySummary()},groups=new Map<string,{rows:NotificationDeliveryRow[];summary:AlertNotificationDeliverySummary}>();
  for(const row of deliveries){let group=groups.get(row.event_id);if(!group){group={rows:[],summary:emptyNotificationDeliverySummary()};groups.set(row.event_id,group);}group.rows.push(row);addDelivery(group.summary,row);addDelivery(summary.delivery,row);}
  const items=rows.map(row=>{summary.byDecision[row.decision]++;if(row.decision==='allowed')summary.allowed++;else summary.skipped++;
    const group=groups.get(row.event_id),item=notificationDecisionDto(row,group?.summary??emptyNotificationDeliverySummary());
    return {...item,deliveries:(group?.rows??[]).map(delivery=>notificationDeliveryDto(delivery,item.eventType))};});
  return {rows,items,summary};
}
function mergeSummary(old:AlertNotificationExport['summary'],next:AlertNotificationExport['summary']):AlertNotificationExport['summary']{
  const summary={total:old.total+next.total,allowed:old.allowed+next.allowed,skipped:old.skipped+next.skipped,byDecision:{...old.byDecision},delivery:{...old.delivery}};
  for(const reason of ALERT_NOTIFICATION_DECISIONS)summary.byDecision[reason]+=next.byDecision[reason];
  for(const key of Object.keys(summary.delivery) as (keyof AlertNotificationDeliverySummary)[])summary.delivery[key]+=next.delivery[key];
  return summary;
}
async function discardAttempt(env:RuntimeEnv,key:string):Promise<void>{try{await env.MAIL_BLOBS.delete(key);}catch{/* Periodic terminal-prefix cleanup also collects unknown late writes. */}}
async function failAttempt(env:RuntimeEnv,job:AsyncAlertNotificationExportRow,at:number,code:string,terminal:boolean,result:AsyncAlertNotificationExportJobResult):Promise<void>{
  const fence=live(job,at),failed=terminal||job.failures+1>=MAX_FAILURES;
  const changed=await statement(env,`UPDATE async_alert_notification_exports SET state=?,lease_token=NULL,lease_until=NULL,failures=failures+1,error_code=?,available_at=?,
    completed_at=?,updated_at=MAX(updated_at+1,?),version=version+1,cleanup_due_at=CASE WHEN ?=1 THEN ? ELSE cleanup_due_at END WHERE ${fence.sql} RETURNING id`,
    failed?'failed':'queued',code,at+Math.min(15*60_000,60_000*2**job.failures),failed?at:null,at,failed?1:0,at,...fence.args).all<{id:string}>();
  if(failed)result.asyncExportsFailed+=changed.results.length;
}

async function processBatch(env:RuntimeEnv,job:AsyncAlertNotificationExportRow,limit:number,now:()=>number,result:AsyncAlertNotificationExportJobResult):Promise<void>{
  let key:string|null=null,checkpointStarted=false,checkpointWillComplete=false;
  try{
    const readStarted=now(),batch=await readBatch(env,job,limit),readFinished=Math.max(now(),readStarted,job.observed_to??0),previous=parseAsyncAlertNotificationExportSummary(job.summary_json);
    if(previous.total!==job.processed_decisions||previous.delivery.total!==job.processed_deliveries||previous.allowed+previous.skipped!==previous.total
      ||previous.byDecision.allowed!==previous.allowed||Object.values(previous.byDecision).reduce((sum,value)=>sum+value,0)!==previous.total
      ||(['pending','running','succeeded','dead','cancelled'] as const).reduce((sum,key)=>sum+previous.delivery[key],0)!==previous.delivery.total)
      throw new ServiceError('async_export_source_changed',409);
    const summary=mergeSummary(previous,batch.summary);
    if(summary.total>MAX_DECISIONS||summary.delivery.total>MAX_DELIVERIES)throw new ServiceError('async_export_limit_exceeded',413);
    const bytes=formatAsyncExportChunk(batch.items,job.format,job.processed_decisions>0);
    if(bytes.byteLength>MAX_FRAGMENT_BYTES)throw new ServiceError('async_export_batch_too_large',413);
    if(job.body_bytes+bytes.byteLength>MAX_BODY_BYTES)throw new ServiceError('async_export_limit_exceeded',413);
    const done=summary.total===job.total_decisions,sequence=job.chunk_count+1,checksum=bytes.byteLength?await sha256(bytes):null;
    checkpointWillComplete=done;
    if(bytes.byteLength){key=`${asyncAlertNotificationExportPrefix(job.mailbox_id,job.id)}${job.lease_token}/${sequence}.part`;
      await env.MAIL_BLOBS.put(key,bytes,{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{jobId:job.id,sha256:checksum!}});}
    const at=now(),fence=live(job,at),last=batch.rows.at(-1),statements:D1PreparedStatement[]=[];
    if(key)statements.push(statement(env,`INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at)
      SELECT id,mailbox_id,?,?,?,?,? FROM async_alert_notification_exports WHERE ${fence.sql}`,sequence,key,bytes.byteLength,checksum,at,...fence.args));
    const receipt=key?' AND EXISTS(SELECT 1 FROM async_alert_notification_export_chunks WHERE job_id=? AND sequence=? AND object_key=?)':'';
    statements.push(statement(env,`UPDATE async_alert_notification_exports SET state=?,processed_decisions=?,processed_deliveries=?,next_time=?,next_event_id=?,
      chunk_count=chunk_count+?,body_bytes=body_bytes+?,summary_json=?,lease_token=NULL,lease_until=NULL,failures=0,error_code=NULL,available_at=?,
      observed_from=COALESCE(observed_from,?),observed_to=?,completed_at=?,updated_at=MAX(updated_at+1,?),version=version+1 WHERE ${fence.sql}${receipt} RETURNING id`,
      done?'succeeded':'queued',summary.total,summary.delivery.total,last?.decided_at??job.next_time,last?.event_id??job.next_event_id,key?1:0,bytes.byteLength,JSON.stringify(summary),
      at,readStarted,readFinished,done?at:null,at,...fence.args,...(key?[job.id,sequence,key]:[])));
    // D1 meta.changes includes AFTER UPDATE trigger writes (terminal notification receipts).
    // RETURNING counts only the fenced export row and must decide whether its R2 object is committed.
    checkpointStarted=true;const checkpoint=await env.DB.batch(statements),committed=checkpoint.at(-1)!.results.length===1;
    if(!committed){if(key)await discardAttempt(env,key);return;}
    result.asyncExportsProcessed++;if(done)result.asyncExportsCompleted++;
  }catch(error){
    // A database response may be lost after commit. Never remove an object that a committed manifest references.
    let published=false,knownUnpublished=!checkpointStarted;
    if(key&&checkpointStarted){try{published=Boolean(await statement(env,'SELECT object_key FROM async_alert_notification_export_chunks WHERE job_id=? AND object_key=?',job.id,key).first());knownUnpublished=!published;}catch{/* Unknown remains retained for reconciliation/expiry. */}}
    if(published){result.asyncExportsProcessed++;if(checkpointWillComplete)result.asyncExportsCompleted++;return;}
    if(key&&knownUnpublished)await discardAttempt(env,key);
    const code=error instanceof ServiceError&&['async_export_batch_too_large','async_export_limit_exceeded','async_export_source_changed'].includes(error.code)?error.code:'async_export_storage_unavailable';
    try{await failAttempt(env,job,now(),code,code!=='async_export_storage_unavailable',result);}catch{console.error(JSON.stringify({event:'async_export_checkpoint_unavailable'}));}
  }
}

async function cleanup(env:RuntimeEnv,at:number,result:AsyncAlertNotificationExportJobResult):Promise<void>{
  const jobs=(await statement(env,`SELECT * FROM async_alert_notification_exports WHERE state IN('failed','cancelled','expired') AND cleanup_due_at<=?
    ORDER BY cleanup_due_at,id LIMIT 2`,at).all<AsyncAlertNotificationExportRow>()).results;
  for(const job of jobs){
    let again=true;
    try{const listed=await env.MAIL_BLOBS.list({prefix:asyncAlertNotificationExportPrefix(job.mailbox_id,job.id),limit:32});
      if(listed.objects.length)await env.MAIL_BLOBS.delete(listed.objects.map(object=>object.key));again=listed.truncated;
      result.asyncExportsCleaned++;
    }catch{console.error(JSON.stringify({event:'async_export_cleanup_unavailable'}));}
    await statement(env,`UPDATE async_alert_notification_exports SET cleanup_due_at=?,last_cleanup_at=?,updated_at=MAX(updated_at+1,?),version=version+1
      WHERE id=? AND mailbox_id=? AND state IN('failed','cancelled','expired') AND version=?`,at+(again?60_000:3_600_000),at,at,job.id,job.mailbox_id,job.version).run();
  }
}

export async function runAsyncAlertNotificationExportJobs(env:RuntimeEnv,options:AsyncAlertNotificationExportJobOptions={}):Promise<AsyncAlertNotificationExportJobResult>{
  const limit=options.batchSize??50,budget=options.maxBatches??10;
  if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(budget)||budget<1||budget>10)throw new ServiceError('invalid_query',400);
  const now=options.now??Date.now,result:AsyncAlertNotificationExportJobResult={asyncExportsProcessed:0,asyncExportsCompleted:0,asyncExportsFailed:0,asyncExportsExpired:0,asyncExportsCleaned:0};
  await expireAndRecover(env,now(),result);
  for(let index=0;index<budget;index++){const job=await claim(env,now());if(!job)break;await processBatch(env,job,limit,now,result);}
  await cleanup(env,now(),result);return result;
}
