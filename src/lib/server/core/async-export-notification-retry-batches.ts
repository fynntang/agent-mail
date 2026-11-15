import type {AsyncExportRetryBatch,AsyncExportRetryBatchItem,AsyncExportRetryBatchList,AsyncExportRetryBatchDetail,AsyncExportRetryBatchPreview,AsyncExportRetryBatchCommit,
  AsyncExportRetryBatchState,AsyncExportRetryBatchItemState,AsyncExportRetryBatchItemReason,AsyncExportBatchFailureReason} from '../../types/async-export-notification-retry-batches';
import {ASYNC_EXPORT_BATCH_FAILURE_REASONS} from '../../types/async-export-notification-retry-batches';
import type {AsyncExportDeliveryRetryBlockReason} from '../../types/async-export-notification-deliveries';
import {asyncExportNotificationRetryEligibility,asyncExportNotificationSecretAvailable,asyncExportNotificationTargetValid} from './async-export-notification-retry';
import {asyncExportNotificationFrozenPayloadValid} from './async-export-notification-delivery-shared';
import type {AsyncExportNotificationRow} from './async-export-notifications';
import {alertNotificationPolicyDto,type AlertNotificationPolicyRow} from './alert-notification-policy';
import type {WebhookEventRow} from './webhooks';
import {sha256,stableId} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError} from './types';

export const BATCH_RETRY_MAX_ITEMS=1000,BATCH_RETRY_PREVIEW_TTL=600000,BATCH_RETRY_TTL=86400000;
export interface BatchRetryRow {
  id:string;mailbox_id:string;preview_request_id:string;request_hash:string;from_ms:number;to_ms:number;filter_reason:AsyncExportBatchFailureReason;
  state:Exclude<AsyncExportRetryBatchState,'cancelled'>;version:number;created_at:number;updated_at:number;expires_at:number;preview_expires_at:number;cancelled_at:number|null;
  commit_request_id:string|null;commit_expected_version:number|null;committed_at:number|null;completed_at:number|null;
  total_items:number;eligible_items:number;processed_items:number;requeued_items:number;skipped_items:number;failed_items:number;unknown_items:number;
}
export interface BatchRetryItemRow {
  batch_id:string;mailbox_id:string;delivery_id:string;job_id:string;expected_updated_at:number;failure_reason:Exclude<AsyncExportBatchFailureReason,'all'>;failed_at:number;
  preview_eligible:number;preview_reason:AsyncExportDeliveryRetryBlockReason|null;state:AsyncExportRetryBatchItemState;client_request_id:string;reason:AsyncExportRetryBatchItemReason|null;
  manual_retry_id:string|null;created_at:number;updated_at:number;completed_at:number|null;lease_token:string|null;lease_until:number|null;version:number;
}
export type AsyncExportNotificationRetryBatchRow=BatchRetryRow;
export type AsyncExportNotificationRetryItemRow=BatchRetryItemRow;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failureReasons:readonly string[]=['all','other',...ASYNC_EXPORT_BATCH_FAILURE_REASONS];
const blockReasons:readonly string[]=['not_dead','not_admitted','mailbox_inactive','endpoint_inactive','budget_exhausted','notifications_disabled','quiet_hours',
  'not_configured','payload_unavailable','signing_key_unavailable','invalid_target'];
const itemReasons:readonly string[]=[...blockReasons,'changed','batch_expired','batch_cancelled','not_submitted','result_unknown','retry_failed','preview_blocked','not_found','receipt_conflict'];
export function batchRetryDto(row:BatchRetryRow,now=Date.now(),active=true):AsyncExportRetryBatch{
  const expired=row.expires_at<=now||row.state==='preview'&&row.preview_expires_at<=now;
  return {id:row.id,mailboxId:row.mailbox_id,window:{from:row.from_ms,to:row.to_ms},filters:{reason:failureReasons.includes(row.filter_reason)?row.filter_reason:'other'},
    state:row.cancelled_at!=null?'cancelled':expired&&row.state!=='completed'?'expired':row.state,version:row.version,totalItems:row.total_items,eligibleItems:row.eligible_items,processedItems:row.processed_items,
    requeuedItems:row.requeued_items,skippedItems:row.skipped_items,failedItems:row.failed_items,unknownItems:row.unknown_items,
    createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,previewExpiresAt:row.preview_expires_at,committedAt:row.committed_at,completedAt:row.completed_at,
    cancelledAt:row.cancelled_at??null,canCommit:active&&row.cancelled_at==null&&!expired&&row.state==='preview',
    canCancel:row.cancelled_at==null&&!expired&&['preview','queued','running'].includes(row.state)};
}
export function batchRetryItemDto(row:BatchRetryItemRow):AsyncExportRetryBatchItem{
  return {deliveryId:row.delivery_id,jobId:row.job_id,expectedUpdatedAt:row.expected_updated_at,failureReason:failureReasons.includes(row.failure_reason)?row.failure_reason:'other',
    failedAt:row.failed_at,previewEligible:row.preview_eligible===1,previewReason:row.preview_reason&&blockReasons.includes(row.preview_reason)?row.preview_reason:null,
    state:row.state,reason:row.reason&&itemReasons.includes(row.reason)?row.reason:null,manualRetryId:row.manual_retry_id,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,version:row.version};
}
async function authorize(ctx:OwnerContext,box:string){requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);return mailbox;}
function time(value:unknown):number|null{if(value===undefined)return null;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ServiceError('batch_retry_invalid',400);return value;}
function inputUuid(value:unknown):asserts value is string{if(typeof value!=='string'||!uuid.test(value))throw new ServiceError('batch_retry_invalid',400);}
type PageQuery={limit?:unknown;cursor?:unknown};
function page(query:PageQuery,box:string,kind:'batches'|'items',batch:string|null){
  objectInput(query,['limit','cursor']);const limit=query.limit===undefined?20:Number(query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let before:{id:string;time:number}|null=null;
  if(query.cursor!==undefined){try{if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));if(!value||Object.keys(value).length!==7||value.v!==1||value.box!==box||value.kind!==kind||value.batch!==batch||value.limit!==limit
      ||typeof value.id!=='string'||!uuid.test(value.id)||!Number.isSafeInteger(value.time)||value.time<0)throw Error();before={id:value.id,time:value.time};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  return {limit,before};
}
function cursor(box:string,kind:'batches'|'items',batch:string|null,limit:number,id:string,time:number){return btoa(JSON.stringify({v:1,box,kind,batch,limit,id,time})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export async function listAsyncExportNotificationRetryBatches(ctx:OwnerContext,box:string,query:PageQuery={}):Promise<AsyncExportRetryBatchList>{
  const mailbox=await authorize(ctx,box),p=page(query,box,'batches',null),rows=(await ctx.env.DB.prepare(`SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=?
    ${p.before?'AND(created_at<? OR(created_at=? AND id<?))':''} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(box,...(p.before?[p.before.time,p.before.time,p.before.id]:[]),p.limit+1).all<BatchRetryRow>()).results;
  const visible=rows.slice(0,p.limit),last=visible.at(-1),at=Date.now();return {batches:visible.map(row=>batchRetryDto(row,at,mailbox.status==='active')),
    nextCursor:rows.length>p.limit&&last?cursor(box,'batches',null,p.limit,last.id,last.created_at):null};
}
export async function getAsyncExportNotificationRetryBatch(ctx:OwnerContext,box:string,id:string,query:PageQuery={}):Promise<AsyncExportRetryBatchDetail>{
  const mailbox=await authorize(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);const p=page(query,box,'items',id);
  const result=await ctx.env.DB.batch([ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id),
    ctx.env.DB.prepare(`SELECT * FROM async_export_notification_retry_items WHERE mailbox_id=? AND batch_id=? ${p.before?'AND delivery_id>?':''} ORDER BY delivery_id LIMIT ?`).bind(box,id,...(p.before?[p.before.id]:[]),p.limit+1)]);
  const batch=result[0].results[0] as unknown as BatchRetryRow|undefined;if(!batch)throw new ServiceError('not_found',404);
  const rows=result[1].results as unknown as BatchRetryItemRow[],visible=rows.slice(0,p.limit),last=visible.at(-1);
  return {batch:batchRetryDto(batch,Date.now(),mailbox.status==='active'),items:visible.map(batchRetryItemDto),nextCursor:rows.length>p.limit&&last?cursor(box,'items',id,p.limit,last.delivery_id,0):null};
}
interface Candidate extends AsyncExportNotificationRow {
  delivery_id:string;endpoint_status:string;mailbox_status:string;delivery_updated_at:number;delivery_budget:number;delivery_payload:string;delivery_secret:string;delivery_url:string;
  last_error_code:string|null;failed_at:number;event_source:string;event_type:string;event_payload:string;event_occurred_at:number;event_created_at:number;
}
export async function previewAsyncExportNotificationRetryBatch(ctx:OwnerContext,box:string,input:unknown):Promise<AsyncExportRetryBatchPreview>{
  await authorize(ctx,box);const data=objectInput(input,['clientRequestId','from','to','reason']);inputUuid(data.clientRequestId);
  const fromInput=time(data.from),toInput=time(data.to),reason=data.reason??'all';if(typeof reason!=='string'||!failureReasons.includes(reason))throw new ServiceError('batch_retry_invalid',400);
  const hash=await sha256(JSON.stringify({from:fromInput,to:toInput,reason}));
  const existing=await ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND preview_request_id=?').bind(box,data.clientRequestId).first<BatchRetryRow>();
  if(existing){if(existing.request_hash!==hash)throw new ServiceError('batch_retry_conflict',409);return {...await getAsyncExportNotificationRetryBatch(ctx,box,existing.id),replayed:true};}
  const at=Date.now(),to=toInput??at+1,from=fromInput??Math.max(0,to-7*86400000);
  if(from>=to||to-from>31*86400000||to>at+60000)throw new ServiceError('batch_retry_invalid',400);
  const reasonFilter=reason==='all'?'':reason==='other'?`AND(d.last_error_code IS NULL OR d.last_error_code NOT IN(SELECT value FROM json_each(?)))`:'AND d.last_error_code=?';
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT n.*,d.id delivery_id,d.updated_at delivery_updated_at,d.attempt_budget delivery_budget,d.payload_json delivery_payload,
      d.signing_secret_ciphertext delivery_secret,d.url_snapshot delivery_url,d.last_error_code,COALESCE(d.completed_at,d.updated_at) failed_at,
      COALESCE(w.status,'disabled') endpoint_status,m.status mailbox_status,e.source event_source,e.type event_type,e.payload_json event_payload,e.occurred_at event_occurred_at,e.created_at event_created_at
      FROM async_export_notifications n JOIN webhook_deliveries d ON d.mailbox_id=n.mailbox_id AND d.event_id=n.event_id
      JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id JOIN mailboxes m ON m.id=n.mailbox_id
      LEFT JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id
      WHERE n.mailbox_id=? AND m.status IN('active','paused') AND d.state='dead' AND COALESCE(d.completed_at,d.updated_at)>=? AND COALESCE(d.completed_at,d.updated_at)<? ${reasonFilter}
      ORDER BY COALESCE(d.completed_at,d.updated_at) DESC,d.id DESC LIMIT 1001`).bind(box,from,to,...(reason==='all'?[]:[reason==='other'?JSON.stringify(ASYNC_EXPORT_BATCH_FAILURE_REASONS):reason])),
    ctx.env.DB.prepare('SELECT * FROM alert_notification_policies WHERE mailbox_id=?').bind(box)
  ]);
  const candidates=result[0].results as unknown as Candidate[];if(candidates.length>BATCH_RETRY_MAX_ITEMS)throw new ServiceError('batch_retry_too_large',413);
  const policy=alertNotificationPolicyDto(result[1].results[0] as unknown as AlertNotificationPolicyRow??null),id=await stableId(`export-notification-retry-batch:v1:${box}:${data.clientRequestId}`),mutation=crypto.randomUUID();
  const items=await Promise.all(candidates.map(async candidate=>{
    const event:WebhookEventRow={id:candidate.event_id!,mailbox_id:box,source:candidate.event_source,type:candidate.event_type,payload_json:candidate.event_payload,occurred_at:candidate.event_occurred_at,created_at:candidate.event_created_at};
    const eligibility=asyncExportNotificationRetryEligibility(ctx.env,{mailboxStatus:candidate.mailbox_status,endpointStatus:candidate.endpoint_status,notificationDecision:candidate.notification_decision,deliveryState:'dead',attemptBudget:candidate.delivery_budget,
      payloadValid:asyncExportNotificationFrozenPayloadValid(candidate,event,candidate.delivery_payload),secretAvailable:asyncExportNotificationSecretAvailable(ctx.env,candidate.delivery_secret),targetValid:asyncExportNotificationTargetValid(ctx.env,candidate.delivery_url)},policy,at);
    return {delivery:candidate.delivery_id,job:candidate.job_id,expected:candidate.delivery_updated_at,failure:ASYNC_EXPORT_BATCH_FAILURE_REASONS.includes(candidate.last_error_code as typeof ASYNC_EXPORT_BATCH_FAILURE_REASONS[number])?candidate.last_error_code:'other',
      failedAt:candidate.failed_at,eligible:eligibility.available?1:0,reason:eligibility.reason,client:await stableId(`export-notification-retry-item:v1:${id}:${candidate.delivery_id}`)};
  }));
  const eligible=items.filter(item=>item.eligible===1).length;
  const inserted=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','export_notification_retry_batch.previewed',?,'success',?,? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status IN('active','paused'))
      AND NOT EXISTS(SELECT 1 FROM async_export_notification_retry_batches WHERE mailbox_id=? AND preview_request_id=?)
      AND(SELECT COUNT(*) FROM async_export_notification_retry_batches WHERE mailbox_id=? AND cancelled_at IS NULL AND state='preview' AND preview_expires_at>? AND expires_at>?)<10`).bind(mutation,box,id,ctx.requestId,at,box,box,data.clientRequestId,box,at,at),
    ctx.env.DB.prepare(`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?) RETURNING id`).bind(id,box,data.clientRequestId,hash,from,to,reason,at,at,at+BATCH_RETRY_TTL,at+BATCH_RETRY_PREVIEW_TTL,items.length,eligible,mutation),
    ctx.env.DB.prepare(`INSERT INTO async_export_notification_retry_items(batch_id,mailbox_id,delivery_id,job_id,expected_updated_at,failure_reason,failed_at,preview_eligible,preview_reason,client_request_id,created_at,updated_at)
      SELECT ?,?,json_extract(value,'$.delivery'),json_extract(value,'$.job'),json_extract(value,'$.expected'),json_extract(value,'$.failure'),json_extract(value,'$.failedAt'),
        json_extract(value,'$.eligible'),json_extract(value,'$.reason'),json_extract(value,'$.client'),?,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(id,box,at,at,JSON.stringify(items),mutation)
  ]);
  if(inserted[1].results.length!==1){const winner=await ctx.env.DB.prepare('SELECT id,request_hash FROM async_export_notification_retry_batches WHERE mailbox_id=? AND preview_request_id=?').bind(box,data.clientRequestId).first<{id:string;request_hash:string}>();
    if(winner){if(winner.request_hash!==hash)throw new ServiceError('batch_retry_conflict',409);return {...await getAsyncExportNotificationRetryBatch(ctx,box,winner.id),replayed:true};}throw new ServiceError('batch_retry_quota',409);}
  return {...await getAsyncExportNotificationRetryBatch(ctx,box,id),replayed:false};
}
export async function commitAsyncExportNotificationRetryBatch(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<AsyncExportRetryBatchCommit>{
  const mailbox=await authorize(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);const data=objectInput(input,['clientRequestId','expectedVersion']);inputUuid(data.clientRequestId);
  if(typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ServiceError('batch_retry_invalid',400);
  let current=await ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id).first<BatchRetryRow>();if(!current)throw new ServiceError('not_found',404);
  const replay=(row:BatchRetryRow):AsyncExportRetryBatchCommit|null=>{if(row.commit_request_id===null)return null;if(row.commit_request_id!==data.clientRequestId||row.commit_expected_version!==data.expectedVersion)throw new ServiceError('batch_retry_conflict',409);return {batch:batchRetryDto(row,Date.now(),mailbox.status==='active'),replayed:true};};
  const prior=replay(current);if(prior)return prior;
  if(current.cancelled_at!==null)throw new ServiceError('batch_retry_changed',409);
  const used=await ctx.env.DB.prepare('SELECT id FROM async_export_notification_retry_batches WHERE mailbox_id=? AND commit_request_id=?').bind(box,data.clientRequestId).first();if(used)throw new ServiceError('batch_retry_conflict',409);
  const at=Date.now();if(current.expires_at<=at||current.preview_expires_at<=at)throw new ServiceError('batch_retry_expired',410);
  if(current.state!=='preview'||current.version!==data.expectedVersion)throw new ServiceError('batch_retry_changed',409);
  if(mailbox.status!=='active')throw new ServiceError('batch_retry_quota',409);
  const mutation=crypto.randomUUID();let changed=false;
  try{const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','export_notification_retry_batch.committed',?,'success',?,? WHERE EXISTS(SELECT 1 FROM async_export_notification_retry_batches b JOIN mailboxes m ON m.id=b.mailbox_id
        WHERE b.id=? AND b.mailbox_id=? AND b.cancelled_at IS NULL AND b.state='preview' AND b.version=? AND b.preview_expires_at>? AND b.expires_at>? AND m.status='active')
      AND(SELECT COUNT(*) FROM async_export_notification_retry_batches WHERE mailbox_id=? AND cancelled_at IS NULL AND state IN('queued','running') AND expires_at>?)<2
      AND(SELECT COUNT(*) FROM async_export_notification_retry_batches WHERE cancelled_at IS NULL AND state IN('queued','running') AND expires_at>?)<4`).bind(mutation,box,id,ctx.requestId,at,id,box,data.expectedVersion,at,at,box,at,at),
    ctx.env.DB.prepare(`UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id=?,commit_expected_version=?,committed_at=?,updated_at=MAX(updated_at+1,?),version=version+1
      WHERE mailbox_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?) RETURNING id`).bind(data.clientRequestId,data.expectedVersion,at,at,box,id,mutation)
  ]);changed=result[1].results.length===1;}catch(error){
    const after=await ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id).first<BatchRetryRow>();
    if(after){const committed=replay(after);if(committed)return committed;}
    if(await ctx.env.DB.prepare('SELECT id FROM async_export_notification_retry_batches WHERE mailbox_id=? AND commit_request_id=?').bind(box,data.clientRequestId).first())throw new ServiceError('batch_retry_conflict',409);throw error;
  }
  current=(await ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id).first<BatchRetryRow>())!;
  if(!changed){const committed=replay(current);if(committed)return committed;throw new ServiceError('batch_retry_quota',409);}
  return {batch:batchRetryDto(current,Date.now(),true),replayed:false};
}
