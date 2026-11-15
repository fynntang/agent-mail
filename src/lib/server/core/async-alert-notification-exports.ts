import type {AsyncAlertNotificationExport,AsyncAlertNotificationExportList,AsyncAlertNotificationExportState} from '../../types/async-alert-notification-exports';
import type {AlertNotificationDecisionList} from '../../types/alert-notification-decisions';
import {ALERT_NOTIFICATION_DECISIONS,authorizeNotificationDecisionRead,prepareNotificationDecisionRead,notificationDecisionFilter} from './alert-notification-decisions';
import {sha256,stableId} from './crypto';
import {objectInput} from './outbound-content';
import type {OwnerContext} from './owner';
import {ServiceError} from './types';

export const ASYNC_ALERT_NOTIFICATION_EXPORT_TTL=86_400_000,ASYNC_ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS=100000;
export const ASYNC_ALERT_NOTIFICATION_EXPORT_ERRORS=['async_export_failed','async_export_storage_unavailable','async_export_limit_exceeded','async_export_batch_too_large',
  'async_export_lease_expired','async_export_checksum_mismatch','async_export_missing_chunk','async_export_expired','async_export_source_changed'] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface AsyncAlertNotificationExportRow {
  id:string;mailbox_id:string;client_request_id:string;request_hash:string;format:'csv'|'json';filter_decision:AsyncAlertNotificationExport['filters']['decision'];
  filter_event_type:AsyncAlertNotificationExport['filters']['eventType'];from_ms:number;to_ms:number;decision_watermark:number;total_decisions:number;
  processed_decisions:number;processed_deliveries:number;next_time:number|null;next_event_id:string|null;chunk_count:number;body_bytes:number;summary_json:string;
  state:AsyncAlertNotificationExportState;error_code:string|null;version:number;created_at:number;updated_at:number;started_at:number|null;completed_at:number|null;expires_at:number;
  observed_from:number|null;observed_to:number|null;lease_token:string|null;lease_until:number|null;attempts:number;failures:number;available_at:number;cleanup_due_at:number;last_cleanup_at:number|null;
}
export type AsyncAlertNotificationExportJobRow=AsyncAlertNotificationExportRow;
export interface AsyncAlertNotificationExportChunkRow {job_id:string;mailbox_id:string;sequence:number;object_key:string;size_bytes:number;sha256:string;created_at:number}
export function defaultAsyncAlertNotificationExportSummary():AlertNotificationDecisionList['summary']{
  return {total:0,allowed:0,skipped:0,byDecision:{allowed:0,disabled:0,quiet_hours:0,repeat_limited:0,recovery_disabled:0,no_subscribers:0},
    delivery:{total:0,pending:0,running:0,succeeded:0,dead:0,cancelled:0,attempts:0,quietDeferred:0}};
}
export function parseAsyncAlertNotificationExportSummary(value:string):AlertNotificationDecisionList['summary']{
  const empty=defaultAsyncAlertNotificationExportSummary();
  try{
    const parsed=JSON.parse(value);for(const key of ['total','allowed','skipped'] as const){if(!Number.isSafeInteger(parsed[key])||parsed[key]<0)throw Error();empty[key]=parsed[key];}
    for(const reason of ALERT_NOTIFICATION_DECISIONS){if(!Number.isSafeInteger(parsed.byDecision[reason])||parsed.byDecision[reason]<0)throw Error();empty.byDecision[reason]=parsed.byDecision[reason];}
    for(const key of Object.keys(empty.delivery) as (keyof typeof empty.delivery)[]){if(!Number.isSafeInteger(parsed.delivery[key])||parsed.delivery[key]<0)throw Error();empty.delivery[key]=parsed.delivery[key];}
    return empty;
  }catch{throw new ServiceError('async_export_source_changed',409);}
}
export function asyncAlertNotificationExportDto(row:AsyncAlertNotificationExportRow,now=Date.now()):AsyncAlertNotificationExport{
  const expired=row.expires_at<=now,state=expired&&['queued','running','succeeded'].includes(row.state)?'expired':row.state;
  let summary:AlertNotificationDecisionList['summary'];try{summary=parseAsyncAlertNotificationExportSummary(row.summary_json);}catch{summary=defaultAsyncAlertNotificationExportSummary();}
  return {id:row.id,mailboxId:row.mailbox_id,format:row.format,state,version:row.version,window:{from:row.from_ms,to:row.to_ms},
    filters:{decision:row.filter_decision,eventType:row.filter_event_type},snapshot:{decisionWatermark:row.decision_watermark},totalDecisions:row.total_decisions,
    processedDecisions:row.processed_decisions,processedDeliveries:row.processed_deliveries,chunkCount:row.chunk_count,bodyBytes:row.body_bytes,summary,
    createdAt:row.created_at,updatedAt:row.updated_at,startedAt:row.started_at,completedAt:row.completed_at,expiresAt:row.expires_at,
    observedFrom:row.observed_from,observedTo:row.observed_to,errorCode:(ASYNC_ALERT_NOTIFICATION_EXPORT_ERRORS as readonly string[]).includes(row.error_code??'')?row.error_code:null,
    canCancel:!expired&&['queued','running'].includes(row.state),downloadAvailable:!expired&&row.state==='succeeded'};
}
async function row(ctx:OwnerContext,box:string,id:string):Promise<AsyncAlertNotificationExportRow>{
  await authorizeNotificationDecisionRead(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);
  const result=await ctx.env.DB.prepare('SELECT * FROM async_alert_notification_exports WHERE mailbox_id=? AND id=?').bind(box,id).first<AsyncAlertNotificationExportRow>();
  if(!result)throw new ServiceError('not_found',404);return result;
}
function optionalTime(value:unknown):number|null{
  if(value===undefined)return null;if(typeof value!=='number'&&(typeof value!=='string'||!/^(0|[1-9]\d{0,15})$/.test(value)))throw new ServiceError('invalid_async_export',400);
  const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new ServiceError('invalid_async_export',400);return number;
}
export async function createAsyncAlertNotificationExport(ctx:OwnerContext,box:string,input:unknown):Promise<{job:AsyncAlertNotificationExport}>{
  await authorizeNotificationDecisionRead(ctx,box);const data=objectInput(input,['clientRequestId','format','decision','eventType','from','to']);
  if(typeof data.clientRequestId!=='string'||!uuid.test(data.clientRequestId)||typeof data.format!=='string'||!['csv','json'].includes(data.format))throw new ServiceError('invalid_async_export',400);
  const decision=data.decision??'all',eventType=data.eventType??'all',from=optionalTime(data.from),to=optionalTime(data.to);
  if(typeof decision!=='string'||!['all',...ALERT_NOTIFICATION_DECISIONS].includes(decision)||typeof eventType!=='string'||!['all','created','resolved'].includes(eventType))throw new ServiceError('invalid_async_export',400);
  const requestHash=await sha256(JSON.stringify({format:data.format,decision,eventType,from,to}));
  const existing=await ctx.env.DB.prepare('SELECT * FROM async_alert_notification_exports WHERE mailbox_id=? AND client_request_id=?').bind(box,data.clientRequestId).first<AsyncAlertNotificationExportRow>();
  if(existing){if(existing.request_hash!==requestHash)throw new ServiceError('async_export_idempotency_conflict',409);return {job:asyncAlertNotificationExportDto(existing)};}
  const p=await prepareNotificationDecisionRead(ctx,box,{decision,eventType,...(from===null?{}:{from}),...(to===null?{}:{to})}),f=notificationDecisionFilter(p),countSql=`SELECT COUNT(*) FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id WHERE ${f.where}`;
  const count=Number(await ctx.env.DB.prepare(countSql).bind(box,...f.args).first('COUNT(*)'));if(count>ASYNC_ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS)throw new ServiceError('async_export_too_large',413);
  const at=Date.now(),id=await stableId(`async-notification-export:${box}:${data.clientRequestId}`),claim=crypto.randomUUID();
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','async_alert_notification_export.created',?,'success',?,? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status IN('active','paused'))
        AND NOT EXISTS(SELECT 1 FROM async_alert_notification_exports WHERE mailbox_id=? AND client_request_id=?)
        AND(SELECT COUNT(*) FROM async_alert_notification_exports WHERE mailbox_id=? AND state IN('queued','running') AND expires_at>?)<2
        AND(SELECT COUNT(*) FROM async_alert_notification_exports WHERE state IN('queued','running') AND expires_at>?)<4`)
      .bind(claim,box,id,ctx.requestId,at,box,box,data.clientRequestId,box,at,at),
    ctx.env.DB.prepare(`INSERT INTO async_alert_notification_exports(id,mailbox_id,client_request_id,request_hash,format,filter_decision,filter_event_type,from_ms,to_ms,
      decision_watermark,total_decisions,summary_json,created_at,updated_at,expires_at,available_at,cleanup_due_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?)`)
      .bind(id,box,data.clientRequestId,requestHash,data.format,decision,eventType,p.from,p.to,p.watermark,count,JSON.stringify(defaultAsyncAlertNotificationExportSummary()),at,at,at+ASYNC_ALERT_NOTIFICATION_EXPORT_TTL,at,at+ASYNC_ALERT_NOTIFICATION_EXPORT_TTL,claim)
  ]);
  if(result[1].meta.changes!==1){
    const winner=await ctx.env.DB.prepare('SELECT * FROM async_alert_notification_exports WHERE mailbox_id=? AND client_request_id=?').bind(box,data.clientRequestId).first<AsyncAlertNotificationExportRow>();
    if(winner){if(winner.request_hash!==requestHash)throw new ServiceError('async_export_idempotency_conflict',409);return {job:asyncAlertNotificationExportDto(winner)};}
    throw new ServiceError('async_export_quota_exceeded',409);
  }
  return {job:asyncAlertNotificationExportDto((await ctx.env.DB.prepare('SELECT * FROM async_alert_notification_exports WHERE id=?').bind(id).first<AsyncAlertNotificationExportRow>())!)};
}
export async function getAsyncAlertNotificationExport(ctx:OwnerContext,box:string,id:string):Promise<{job:AsyncAlertNotificationExport}>{return {job:asyncAlertNotificationExportDto(await row(ctx,box,id))};}
export async function listAsyncAlertNotificationExports(ctx:OwnerContext,box:string,query:{limit?:unknown;cursor?:unknown}={}):Promise<AsyncAlertNotificationExportList>{
  await authorizeNotificationDecisionRead(ctx,box);objectInput(query,['limit','cursor']);const limit=query.limit===undefined?20:Number(query.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);let before:{time:number;id:string}|null=null;
  if(query.cursor!==undefined){try{if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));if(!value||Object.keys(value).length!==5||value.v!==1||value.box!==box||value.limit!==limit||!Number.isSafeInteger(value.time)||value.time<0||typeof value.id!=='string'||!uuid.test(value.id))throw Error();before={time:value.time,id:value.id};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const results=(await ctx.env.DB.prepare(`SELECT * FROM async_alert_notification_exports WHERE mailbox_id=? ${before?'AND(created_at<? OR(created_at=? AND id<?))':''}
    ORDER BY created_at DESC,id DESC LIMIT ?`).bind(box,...(before?[before.time,before.time,before.id]:[]),limit+1).all<AsyncAlertNotificationExportRow>()).results;
  const visible=results.slice(0,limit),last=visible.at(-1),nextCursor=results.length>limit&&last?btoa(JSON.stringify({v:1,box,limit,time:last.created_at,id:last.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {jobs:visible.map(value=>asyncAlertNotificationExportDto(value)),nextCursor};
}
export async function cancelAsyncAlertNotificationExport(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<{job:AsyncAlertNotificationExport}>{
  const current=await row(ctx,box,id),data=objectInput(input,['expectedVersion']);if(typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ServiceError('invalid_async_export',400);
  if(data.expectedVersion!==current.version)throw new ServiceError('async_export_changed',409);const at=Date.now();if(current.expires_at<=at||!['queued','running'].includes(current.state))throw new ServiceError('async_export_not_cancellable',409);
  const claim=crypto.randomUUID();const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','async_alert_notification_export.cancelled',?,'success',?,? WHERE EXISTS(SELECT 1 FROM async_alert_notification_exports WHERE mailbox_id=? AND id=? AND version=? AND state IN('queued','running') AND expires_at>?)`)
      .bind(claim,box,id,ctx.requestId,at,box,id,current.version,at),
    ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state='cancelled',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=MAX(updated_at+1,?),completed_at=?,cleanup_due_at=?
      WHERE mailbox_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(at,at,at,box,id,claim)
  ]);if(result[1].meta.changes!==1)throw new ServiceError('async_export_changed',409);return getAsyncAlertNotificationExport(ctx,box,id);
}
