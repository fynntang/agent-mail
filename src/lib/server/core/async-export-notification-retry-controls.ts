import type {AsyncExportRetryBatchControlOperation,AsyncExportRetryBatchControlResult,AsyncExportRetryBatchOperationList} from '../../types/async-export-notification-retry-batches';
import {batchRetryDto,type BatchRetryRow,type BatchRetryItemRow} from './async-export-notification-retry-batches';
import {findAsyncExportNotificationRetryReceipt} from './async-export-notification-retry';
import {exportRetryBatchSyncStatement} from './async-export-notification-retry-batch-shared';
import {stableId} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {ServiceError} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const actions={preview:'export_notification_retry_batch.previewed',commit:'export_notification_retry_batch.committed',cancel:'export_notification_retry_batch.cancelled',reconcile:'export_notification_retry_batch.reconciled'} as const;
type ControlAction='cancel'|'reconcile';
interface Intent {operation:ControlAction;batchId:string;clientRequestId:string;expectedVersion:number;deliveryId:string|null}
interface Audit {id:string;mailbox_id:string;resource_id:string;action:string;metadata_json:string;occurred_at:number;preview_request_id?:string;commit_request_id?:string|null;commit_expected_version?:number|null}
type OperationItem=NonNullable<AsyncExportRetryBatchControlOperation['items']>[number];
const fail=(code:'invalid'|'changed'|'conflict'|'unavailable'):never=>{throw new ServiceError(`batch_control_${code}`,code==='invalid'?400:409);};
async function authorize(ctx:OwnerContext,box:string,id:string){requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status)||!uuid.test(id))throw new ServiceError('not_found',404);return mailbox;}
function intent(input:unknown,operation:ControlAction,batchId:string):Intent{
  if(!input||typeof input!=='object'||Array.isArray(input))return fail('invalid');const data=input as Record<string,unknown>;
  if(Object.keys(data).some(key=>!['clientRequestId','expectedVersion',...(operation==='reconcile'?['deliveryId']:[])].includes(key))
    ||typeof data.clientRequestId!=='string'||!uuid.test(data.clientRequestId)||typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1
    ||data.deliveryId!==undefined&&(typeof data.deliveryId!=='string'||!uuid.test(data.deliveryId)))return fail('invalid');
  return {operation,batchId,clientRequestId:data.clientRequestId,expectedVersion:data.expectedVersion,deliveryId:data.deliveryId as string??null};
}
function metadata(row:Audit):Record<string,unknown>{try{const data=JSON.parse(row.metadata_json);return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}}
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
/** Strict projection keeps private audit metadata out of the Owner API. */
function operationDto(row:Audit):AsyncExportRetryBatchControlOperation{
  const action=(Object.entries(actions).find(([,value])=>value===row.action)?.[0]??'preview') as AsyncExportRetryBatchControlOperation['action'],data=metadata(row);
  const summary:AsyncExportRetryBatchControlOperation['summary']={};
  for(const [key,field] of [['stopped','stoppedItems'],['unknown','unknownItems'],['retained','retainedItems'],['requeued','requeuedItems'],['notSubmitted','notSubmittedItems'],['unresolved','unresolvedItems']] as const)
    if(integer(data[field]))summary[key]=data[field];
  const result:AsyncExportRetryBatchControlOperation={id:row.id,action,clientRequestId:typeof data.clientRequestId==='string'&&uuid.test(data.clientRequestId)?data.clientRequestId:
    action==='preview'?row.preview_request_id??null:action==='commit'?row.commit_request_id??null:null,
    expectedVersion:integer(data.expectedVersion)?data.expectedVersion:action==='commit'?row.commit_expected_version??null:null,occurredAt:row.occurred_at,summary};
  if(action==='reconcile'&&Array.isArray(data.items))result.items=data.items.slice(0,20).flatMap((item:unknown)=>{
    if(!item||typeof item!=='object')return [];const value=item as Record<string,unknown>;
    if(typeof value.deliveryId!=='string'||!uuid.test(value.deliveryId)||!['receipt_found','not_submitted','receipt_conflict'].includes(String(value.outcome))
      ||value.beforeState!=='unknown'||!['requeued','skipped','unknown'].includes(String(value.afterState)))return [];
    return [{deliveryId:value.deliveryId,outcome:value.outcome,beforeState:'unknown',afterState:value.afterState} as OperationItem];
  });return result;
}
async function batch(ctx:OwnerContext,box:string,id:string):Promise<BatchRetryRow>{const row=await ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id).first<BatchRetryRow>();if(!row)throw new ServiceError('not_found',404);return row;}
async function audit(ctx:OwnerContext,id:string){return ctx.env.DB.prepare('SELECT id,mailbox_id,resource_id,action,metadata_json,occurred_at FROM audit_events WHERE id=?').bind(id).first<Audit>();}
function validateReceipt(row:Audit,box:string,request:Intent):AsyncExportRetryBatchControlOperation{
  const data=metadata(row);if(row.mailbox_id!==box||row.resource_id!==request.batchId||row.action!==actions[request.operation]||data.operation!==request.operation
    ||data.batchId!==request.batchId||data.clientRequestId!==request.clientRequestId||data.expectedVersion!==request.expectedVersion||(data.deliveryId??null)!==request.deliveryId)return fail('conflict');
  return operationDto(row);
}
async function result(ctx:OwnerContext,box:string,request:Intent,receipt:Audit,replayed:boolean):Promise<AsyncExportRetryBatchControlResult>{
  const operation=validateReceipt(receipt,box,request),current=await batch(ctx,box,request.batchId),mailbox=await getMailbox(ctx,box);
  if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
  return {batch:batchRetryDto(current,Date.now(),mailbox.status==='active'),replayed,operation};
}
/** A matching operation may commit after the first receipt lookup but before the snapshot. */
async function replayOrFail(ctx:OwnerContext,box:string,request:Intent,receiptId:string,code:'changed'|'unavailable'):Promise<AsyncExportRetryBatchControlResult>{
  const accepted=await audit(ctx,receiptId);if(accepted)return result(ctx,box,request,accepted,true);return fail(code);
}
function auditInsert(ctx:OwnerContext,box:string,request:Intent,id:string,at:number,data:Record<string,unknown>,guard:string,args:(number|string)[]){
  return ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
    SELECT ?,?,'owner',?,?,'success',?,?,? WHERE EXISTS(SELECT 1 FROM async_export_notification_retry_batches b JOIN mailboxes m ON m.id=b.mailbox_id
      WHERE b.mailbox_id=? AND b.id=? AND b.version=? AND m.status IN('active','paused') ${guard}) ON CONFLICT(id) DO NOTHING`)
    .bind(id,box,actions[request.operation],request.batchId,ctx.requestId,JSON.stringify({...request,...data}),at,box,request.batchId,request.expectedVersion,...args);
}
/** Cancel only unexecuted work; already queued Webhook deliveries retain their results and budgets. */
export async function cancelAsyncExportNotificationRetryBatch(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<AsyncExportRetryBatchControlResult>{
  await authorize(ctx,box,id);const request=intent(input,'cancel',id),receiptId=await stableId(`export-retry-control:v1:${box}:${request.clientRequestId}`),prior=await audit(ctx,receiptId);
  if(prior)return result(ctx,box,request,prior,true);
  const snapshot=await ctx.env.DB.batch([ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id),
    ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_items WHERE mailbox_id=? AND batch_id=? ORDER BY delivery_id').bind(box,id)]);
  const current=snapshot[0].results[0] as unknown as BatchRetryRow|undefined;if(!current)throw new ServiceError('not_found',404);
  if(current.version!==request.expectedVersion)return replayOrFail(ctx,box,request,receiptId,'changed');const at=Date.now();
  if(!batchRetryDto(current,at).canCancel)return replayOrFail(ctx,box,request,receiptId,'unavailable');
  const items=snapshot[1].results as unknown as BatchRetryItemRow[],stopped=items.filter(item=>item.state==='pending').length,unknown=items.filter(item=>item.state==='running'||item.state==='unknown').length;
  const versions=JSON.stringify(items.map(item=>({id:item.delivery_id,version:item.version})));
  let changed=false;
  try{const applied=await ctx.env.DB.batch([
    auditInsert(ctx,box,request,receiptId,at,{stoppedItems:stopped,unknownItems:unknown,retainedItems:items.length-stopped-items.filter(item=>item.state==='running').length},
      `AND b.cancelled_at IS NULL AND b.state IN('preview','queued','running') AND b.expires_at>? AND(b.state<>'preview' OR b.preview_expires_at>?)
       AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN async_export_notification_retry_items i ON i.batch_id=b.id AND i.mailbox_id=b.mailbox_id AND i.delivery_id=json_extract(j.value,'$.id') WHERE i.delivery_id IS NULL OR i.version<>json_extract(j.value,'$.version'))`,[at,at,versions]),
    ctx.env.DB.prepare(`UPDATE async_export_notification_retry_batches SET cancelled_at=?,version=version+1,updated_at=MAX(updated_at+1,?)
      WHERE mailbox_id=? AND id=? AND version=? AND cancelled_at IS NULL AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND mailbox_id=? AND resource_id=? AND action=?) RETURNING id`).bind(at,at,box,id,request.expectedVersion,receiptId,box,id,actions.cancel),
    ctx.env.DB.prepare(`UPDATE async_export_notification_retry_items SET state=CASE state WHEN 'pending' THEN 'skipped' ELSE 'unknown' END,
      reason=CASE state WHEN 'pending' THEN 'batch_cancelled' ELSE 'result_unknown' END,lease_token=NULL,lease_until=NULL,completed_at=COALESCE(completed_at,?),version=version+1,updated_at=MAX(updated_at+1,?)
      WHERE mailbox_id=? AND batch_id=? AND state IN('pending','running') AND EXISTS(SELECT 1 FROM async_export_notification_retry_batches b WHERE b.id=? AND b.mailbox_id=? AND b.version=? AND b.cancelled_at=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND mailbox_id=? AND resource_id=? AND action=?))`)
      .bind(at,at,box,id,id,box,request.expectedVersion+1,at,receiptId,box,id,actions.cancel),
    exportRetryBatchSyncStatement(ctx.env,id,at,{mailboxId:box,expectedVersion:request.expectedVersion+1,auditId:receiptId})
  ]);changed=applied[1].results.length===1;}catch{const accepted=await audit(ctx,receiptId);if(accepted)return result(ctx,box,request,accepted,true);return fail('unavailable');}
  const accepted=await audit(ctx,receiptId);if(accepted)return result(ctx,box,request,accepted,!changed);return fail('changed');
}
/** Resolve immutable single-retry receipts only; this operation never invokes a retry or a transport. */
export async function reconcileAsyncExportNotificationRetryBatch(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<AsyncExportRetryBatchControlResult>{
  await authorize(ctx,box,id);const request=intent(input,'reconcile',id),receiptId=await stableId(`export-retry-control:v1:${box}:${request.clientRequestId}`),prior=await audit(ctx,receiptId);
  if(prior)return result(ctx,box,request,prior,true);
  const snapshot=await ctx.env.DB.batch([ctx.env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE mailbox_id=? AND id=?').bind(box,id),
    ctx.env.DB.prepare(`SELECT * FROM async_export_notification_retry_items WHERE mailbox_id=? AND batch_id=? AND state='unknown' ${request.deliveryId?'AND delivery_id=?':''} ORDER BY delivery_id LIMIT 20`).bind(box,id,...(request.deliveryId?[request.deliveryId]:[]))]);
  const current=snapshot[0].results[0] as unknown as BatchRetryRow|undefined;if(!current)throw new ServiceError('not_found',404);if(current.version!==request.expectedVersion)return replayOrFail(ctx,box,request,receiptId,'changed');
  const items=snapshot[1].results as unknown as BatchRetryItemRow[];if(!items.length)return replayOrFail(ctx,box,request,receiptId,'unavailable');
  const outcomes=await Promise.all(items.map(async item=>{
    const singleReceiptId=await stableId(`async-export-notification-retry:v1:${box}:${item.client_request_id}`);
    try{const found=await findAsyncExportNotificationRetryReceipt(ctx.env,box,item.job_id,item.delivery_id,item.client_request_id,item.expected_updated_at);
      return {item,singleReceiptId,proof:await audit(ctx,singleReceiptId),manualId:found?.id??null,outcome:found?'receipt_found' as const:'not_submitted' as const,state:found?'requeued' as const:'skipped' as const};
    }catch(error){if(!(error instanceof ServiceError)||error.code!=='export_notification_retry_conflict')throw error;
      return {item,singleReceiptId,proof:await audit(ctx,singleReceiptId),manualId:null,outcome:'receipt_conflict' as const,state:'unknown' as const};}
  })).catch(()=>fail('unavailable'));
  const at=Date.now(),safeItems:OperationItem[]=outcomes.map(value=>({deliveryId:value.item.delivery_id,outcome:value.outcome,beforeState:'unknown',afterState:value.state}));
  const versions=JSON.stringify(outcomes.map(value=>({id:value.item.delivery_id,version:value.item.version,receipt:value.singleReceiptId,missing:value.outcome==='not_submitted'?1:0,
    metadata:value.proof?.metadata_json,action:value.proof?.action,box:value.proof?.mailbox_id,resource:value.proof?.resource_id})));
  let changed=false;
  try{const applied=await ctx.env.DB.batch([
    auditInsert(ctx,box,request,receiptId,at,{requeuedItems:outcomes.filter(value=>value.outcome==='receipt_found').length,notSubmittedItems:outcomes.filter(value=>value.outcome==='not_submitted').length,
      unresolvedItems:outcomes.filter(value=>value.outcome==='receipt_conflict').length,items:safeItems},
      `AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN async_export_notification_retry_items i ON i.batch_id=b.id AND i.mailbox_id=b.mailbox_id AND i.delivery_id=json_extract(j.value,'$.id')
        WHERE i.delivery_id IS NULL OR i.state<>'unknown' OR i.version<>json_extract(j.value,'$.version')
          OR(json_extract(j.value,'$.missing')=1 AND EXISTS(SELECT 1 FROM audit_events a WHERE a.id=json_extract(j.value,'$.receipt')))
          OR(json_extract(j.value,'$.missing')=0 AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=json_extract(j.value,'$.receipt') AND a.mailbox_id=json_extract(j.value,'$.box')
            AND a.resource_id=json_extract(j.value,'$.resource') AND a.action=json_extract(j.value,'$.action') AND a.metadata_json=json_extract(j.value,'$.metadata'))))`,[versions]),
    ...outcomes.map(value=>ctx.env.DB.prepare(`UPDATE async_export_notification_retry_items SET state=?,reason=?,manual_retry_id=COALESCE(manual_retry_id,?),
      completed_at=COALESCE(completed_at,?),lease_token=NULL,lease_until=NULL,version=version+1,updated_at=MAX(updated_at+1,?)
      WHERE mailbox_id=? AND batch_id=? AND delivery_id=? AND state='unknown' AND version=? AND EXISTS(SELECT 1 FROM async_export_notification_retry_batches b WHERE b.id=? AND b.mailbox_id=? AND b.version=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=? AND mailbox_id=? AND resource_id=? AND action=?))`)
      .bind(value.state,value.outcome==='receipt_found'?null:value.outcome==='not_submitted'?'not_submitted':'receipt_conflict',value.manualId,at,at,box,id,value.item.delivery_id,value.item.version,id,box,request.expectedVersion,receiptId,box,id,actions.reconcile)),
    exportRetryBatchSyncStatement(ctx.env,id,at,{mailboxId:box,expectedVersion:request.expectedVersion,auditId:receiptId})
  ]);changed=applied.at(-1)!.results.length===1;}catch{const accepted=await audit(ctx,receiptId);if(accepted)return result(ctx,box,request,accepted,true);return fail('unavailable');}
  const accepted=await audit(ctx,receiptId);if(accepted)return result(ctx,box,request,accepted,!changed);return fail('changed');
}
export async function listAsyncExportNotificationRetryBatchOperations(ctx:OwnerContext,box:string,id:string,query:{limit?:unknown;cursor?:unknown}={}):Promise<AsyncExportRetryBatchOperationList>{
  await authorize(ctx,box,id);await batch(ctx,box,id);
  if(Object.keys(query).some(key=>!['limit','cursor'].includes(key)))throw new ServiceError('invalid_query',400);
  const limit=query.limit===undefined?20:Number(query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let before:{id:string;time:number}|null=null;
  if(query.cursor!==undefined){try{if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!value||Object.keys(value).length!==7||value.v!==1||value.kind!=='retry_operations'||value.box!==box||value.batch!==id||value.limit!==limit||typeof value.id!=='string'||!uuid.test(value.id)||!integer(value.time))throw Error();before={id:value.id,time:value.time};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const rows=(await ctx.env.DB.prepare(`SELECT a.*,b.preview_request_id,b.commit_request_id,b.commit_expected_version FROM audit_events a JOIN async_export_notification_retry_batches b ON b.mailbox_id=a.mailbox_id AND b.id=a.resource_id
    WHERE a.mailbox_id=? AND a.resource_id=? AND a.action IN(?,?,?,?) AND a.outcome='success' ${before?'AND(a.occurred_at<? OR(a.occurred_at=? AND a.id<?))':''}
    ORDER BY a.occurred_at DESC,a.id DESC LIMIT ?`).bind(box,id,...Object.values(actions),...(before?[before.time,before.time,before.id]:[]),limit+1).all<Audit>()).results;
  const visible=rows.slice(0,limit),last=visible.at(-1);
  return {operations:visible.map(operationDto),nextCursor:rows.length>limit&&last?btoa(JSON.stringify({v:1,kind:'retry_operations',box,batch:id,limit,id:last.id,time:last.occurred_at})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null};
}
