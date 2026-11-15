import type {RetryBatchNotification,RetryBatchNotificationKind,RetryBatchNotificationReason,RetryBatchNotificationList} from '../../types/retry-batch-notifications';
import type {AsyncExportNotificationDecision} from '../../types/async-export-notifications';
import type {AsyncExportRetryBatchState} from '../../types/async-export-notification-retry-batches';
import {stableId} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kinds:readonly RetryBatchNotificationKind[]=['completed','failed','needs_reconciliation'];
const decisions:readonly AsyncExportNotificationDecision[]=['allowed','disabled','quiet_hours','repeat_limited','no_subscribers'];
export interface RetryBatchNotificationRow {
  id:string;mailbox_id:string;batch_id:string;kind:RetryBatchNotificationKind;reason:RetryBatchNotificationReason;source_version:number;batch_state:AsyncExportRetryBatchState;endpoint_snapshot_json:string;
  total_items:number;eligible_items:number;processed_items:number;requeued_items:number;skipped_items:number;failed_items:number;unknown_items:number;
  occurred_at:number;created_at:number;acknowledged_at:number|null;version:number;event_id:string|null;projected_at:number|null;
  notification_decision:AsyncExportNotificationDecision|null;policy_version:number|null;decided_at:number|null;claim_token:string|null;
}
interface JoinedRow extends RetryBatchNotificationRow {
  current_state:Exclude<AsyncExportRetryBatchState,'cancelled'>;current_version:number;current_cancelled_at:number|null;current_expires_at:number;current_preview_expires_at:number;
  current_total_items:number;current_eligible_items:number;current_processed_items:number;current_requeued_items:number;current_skipped_items:number;current_failed_items:number;current_unknown_items:number;
}
const liveColumns=`b.state current_state,b.version current_version,b.cancelled_at current_cancelled_at,b.expires_at current_expires_at,b.preview_expires_at current_preview_expires_at,
  b.total_items current_total_items,b.eligible_items current_eligible_items,b.processed_items current_processed_items,b.requeued_items current_requeued_items,
  b.skipped_items current_skipped_items,b.failed_items current_failed_items,b.unknown_items current_unknown_items`;
const joined='async_export_retry_batch_notifications n JOIN async_export_notification_retry_batches b ON b.id=n.batch_id AND b.mailbox_id=n.mailbox_id';
const attention=`((n.kind='needs_reconciliation' AND b.unknown_items>0) OR(n.kind='failed' AND(b.failed_items>0 OR(b.state='expired' AND b.cancelled_at IS NULL))))`;
export function retryBatchNotificationDto(row:JoinedRow):RetryBatchNotification{
  const expired=row.current_expires_at<=Date.now()||row.current_state==='preview'&&row.current_preview_expires_at<=Date.now();
  const state=row.current_cancelled_at!==null?'cancelled':row.current_state!=='completed'&&expired?'expired':row.current_state;
  return {id:row.id,mailboxId:row.mailbox_id,batchId:row.batch_id,kind:row.kind,reason:row.reason,batchState:row.batch_state,sourceVersion:row.source_version,
    totalItems:row.total_items,eligibleItems:row.eligible_items,processedItems:row.processed_items,requeuedItems:row.requeued_items,skippedItems:row.skipped_items,failedItems:row.failed_items,unknownItems:row.unknown_items,
    occurredAt:row.occurred_at,createdAt:row.created_at,acknowledgedAt:row.acknowledged_at,version:row.version,
    notificationDecision:row.notification_decision&&decisions.includes(row.notification_decision)?row.notification_decision:null,policyVersion:row.policy_version,decidedAt:row.decided_at,
    currentAttention:row.kind==='needs_reconciliation'?row.current_unknown_items>0:row.kind==='failed'?row.current_failed_items>0||row.current_state==='expired'&&row.current_cancelled_at===null:false,
    currentBatch:{state,version:row.current_version,totalItems:row.current_total_items,eligibleItems:row.current_eligible_items,processedItems:row.current_processed_items,
      requeuedItems:row.current_requeued_items,skippedItems:row.current_skipped_items,failedItems:row.current_failed_items,unknownItems:row.current_unknown_items}};
}
async function authorize(ctx:OwnerContext,box:string){requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);}
async function row(ctx:OwnerContext,box:string,id:string):Promise<JoinedRow>{
  await authorize(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);
  const found=await ctx.env.DB.prepare(`SELECT n.*,${liveColumns} FROM ${joined} WHERE n.mailbox_id=? AND n.id=?`).bind(box,id).first<JoinedRow>();
  if(!found)throw new ServiceError('not_found',404);return found;
}
export async function getRetryBatchNotification(ctx:OwnerContext,box:string,id:string):Promise<{notification:RetryBatchNotification}>{return {notification:retryBatchNotificationDto(await row(ctx,box,id))};}
export async function listRetryBatchNotifications(ctx:OwnerContext,box:string,query:{status?:unknown;kind?:unknown;limit?:unknown;cursor?:unknown}={}):Promise<RetryBatchNotificationList>{
  await authorize(ctx,box);objectInput(query,['status','kind','limit','cursor']);
  const status=query.status??'unread',kind=query.kind??'all',limit=query.limit===undefined?20:Number(query.limit);
  if(typeof status!=='string'||!['unread','acknowledged','all'].includes(status)||typeof kind!=='string'||!['all',...kinds].includes(kind)
    ||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let before:{id:string;time:number}|null=null;
  if(query.cursor!==undefined){try{
    if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!value||Object.keys(value).length!==8||value.v!==1||value.type!=='retry_batch_notifications'||value.box!==box||value.status!==status||value.kind!==kind||value.limit!==limit
      ||typeof value.id!=='string'||!uuid.test(value.id)||!Number.isSafeInteger(value.time)||value.time<0)throw Error();before={id:value.id,time:value.time};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT n.*,${liveColumns} FROM ${joined} WHERE n.mailbox_id=?
      ${status==='all'?'':status==='unread'?'AND n.acknowledged_at IS NULL':'AND n.acknowledged_at IS NOT NULL'} ${kind==='all'?'':'AND n.kind=?'}
      ${before?'AND(n.created_at<? OR(n.created_at=? AND n.id<?))':''} ORDER BY n.created_at DESC,n.id DESC LIMIT ?`)
      .bind(box,...(kind==='all'?[]:[kind]),...(before?[before.time,before.time,before.id]:[]),limit+1),
    ctx.env.DB.prepare(`SELECT COALESCE(SUM(n.acknowledged_at IS NULL),0) unread,COALESCE(SUM(n.acknowledged_at IS NULL AND ${attention}),0) attention,
      COALESCE(SUM(n.kind='completed'),0) completed,COALESCE(SUM(n.kind='failed'),0) failed,COALESCE(SUM(n.kind='needs_reconciliation'),0) needsReconciliation FROM ${joined} WHERE n.mailbox_id=?`).bind(box)
  ]);
  const rows=result[0].results as unknown as JoinedRow[],visible=rows.slice(0,limit),last=visible.at(-1);
  return {notifications:visible.map(retryBatchNotificationDto),summary:result[1].results[0] as unknown as RetryBatchNotificationList['summary'],
    nextCursor:rows.length>limit&&last?btoa(JSON.stringify({v:1,type:'retry_batch_notifications',box,status,kind,limit,id:last.id,time:last.created_at})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null};
}
export async function acknowledgeRetryBatchNotification(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<{notification:RetryBatchNotification}>{
  const current=await row(ctx,box,id),data=objectInput(input,['expectedVersion']);
  if(typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ServiceError('invalid_input',400);
  if(data.expectedVersion!==current.version||current.acknowledged_at!==null)throw new ServiceError('retry_batch_notification_changed',409);
  const mutation=crypto.randomUUID(),at=Math.max(Date.now(),current.created_at);
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','retry_batch_notification.acknowledged',?,'success',?,? WHERE EXISTS(SELECT 1 FROM async_export_retry_batch_notifications n JOIN mailboxes m ON m.id=n.mailbox_id
        WHERE n.id=? AND n.mailbox_id=? AND n.version=? AND n.acknowledged_at IS NULL AND m.status IN('active','paused'))`).bind(mutation,box,id,ctx.requestId,at,id,box,current.version),
    ctx.env.DB.prepare(`UPDATE async_export_retry_batch_notifications SET acknowledged_at=?,version=version+1 WHERE id=? AND mailbox_id=? AND version=? AND acknowledged_at IS NULL
      AND EXISTS(SELECT 1 FROM audit_events WHERE id=?) RETURNING id`).bind(at,id,box,current.version,mutation)
  ]);if(result[1].results.length!==1)throw new ServiceError('retry_batch_notification_changed',409);
  return getRetryBatchNotification(ctx,box,id);
}
/** Owner reminders are independent of Webhook availability, admission policy and secret keys. */
export async function retryBatchNotice(ctx:OwnerContext):Promise<{count:number;attentionCount:number;mailboxId:string}|null>{
  requireOwner(ctx.actor);
  const result=await ctx.env.DB.prepare(`WITH visible AS(SELECT n.id,n.mailbox_id,n.created_at,${attention} attention FROM ${joined} JOIN mailboxes m ON m.id=n.mailbox_id
    WHERE n.acknowledged_at IS NULL AND m.status IN('active','paused'))
    SELECT COUNT(*) count,COALESCE(SUM(attention),0) attentionCount,(SELECT mailbox_id FROM visible ORDER BY attention DESC,created_at DESC,id DESC LIMIT 1) mailboxId FROM visible`).first<{count:number;attentionCount:number;mailboxId:string|null}>();
  return result&&result.count>0&&result.mailboxId?{count:result.count,attentionCount:result.attentionCount,mailboxId:result.mailboxId}:null;
}
/** Capture is transactional; this bounded projection only appends a stable event for each immutable fact. */
export async function projectRetryBatchNotifications(env:RuntimeEnv,options:{now?:()=>number}={}):Promise<{retryBatchNotificationsProjected:number}>{
  const now=options.now??Date.now,items=(await env.DB.prepare(`SELECT n.* FROM async_export_retry_batch_notifications n JOIN mailboxes m ON m.id=n.mailbox_id
    WHERE n.projected_at IS NULL AND m.status IN('active','paused') ORDER BY n.created_at,n.id LIMIT 20`).all<RetryBatchNotificationRow>()).results;
  let count=0;
  for(const item of items){
    const source=`retry-batch-notification:v1:${item.id}`,eventId=await stableId(source),type=`alert_notification.retry_batch.${item.kind}`;
    const payload=JSON.stringify({notificationId:item.id,batchId:item.batch_id,kind:item.kind,reason:item.reason,batchState:item.batch_state,sourceVersion:item.source_version,
      totalItems:item.total_items,eligibleItems:item.eligible_items,processedItems:item.processed_items,requeuedItems:item.requeued_items,skippedItems:item.skipped_items,
      failedItems:item.failed_items,unknownItems:item.unknown_items,occurredAt:item.occurred_at});
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
        SELECT ?,mailbox_id,'app',?,?,?,?,created_at FROM async_export_retry_batch_notifications n WHERE n.id=? AND n.mailbox_id=? AND n.projected_at IS NULL
          AND EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=n.mailbox_id AND m.status IN('active','paused')) ON CONFLICT(id) DO NOTHING`)
        .bind(eventId,source,type,payload,item.occurred_at,item.id,item.mailbox_id),
      env.DB.prepare(`UPDATE async_export_retry_batch_notifications SET event_id=?,projected_at=? WHERE id=? AND mailbox_id=? AND projected_at IS NULL
        AND EXISTS(SELECT 1 FROM events e WHERE e.id=? AND e.mailbox_id=async_export_retry_batch_notifications.mailbox_id AND e.source='app' AND e.source_event_id=?
          AND e.type=? AND e.payload_json=? AND e.occurred_at=async_export_retry_batch_notifications.occurred_at AND e.created_at=async_export_retry_batch_notifications.created_at) RETURNING id`)
        .bind(eventId,Math.max(now(),item.created_at),item.id,item.mailbox_id,eventId,source,type,payload)
    ]);count+=result[1].results.length;
  }return {retryBatchNotificationsProjected:count};
}
