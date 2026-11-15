import type {AsyncExportRetryBatchItemReason,AsyncExportRetryBatchItemState} from '../../types/async-export-notification-retry-batches';
import {findAsyncExportNotificationRetryReceipt,retryAsyncExportNotificationDelivery} from './async-export-notification-retry';
import {getAsyncExportNotificationDelivery} from './async-export-notification-deliveries';
import {exportRetryBatchSyncStatement} from './async-export-notification-retry-batch-shared';
import type {OwnerContext} from './owner';
import {ServiceError,type RuntimeEnv} from './types';

const LEASE_MS=120_000,RECONCILE_DELAY_MS=60_000;
interface Item {
  batch_id:string;mailbox_id:string;delivery_id:string;job_id:string;expected_updated_at:number;client_request_id:string;
  preview_eligible:number;preview_reason:AsyncExportRetryBatchItemReason|null;state:AsyncExportRetryBatchItemState;
  version:number;lease_token:string|null;lease_until:number|null;created_at:number;updated_at:number;manual_retry_id:string|null;
  batch_state:'queued'|'running'|'expired';batch_expires_at:number;
}
type ResultState='requeued'|'skipped'|'failed'|'unknown';
export interface AsyncExportNotificationRetryBatchJobOptions{now?:()=>number;maxItems?:number}
export interface AsyncExportNotificationRetryBatchJobResult{
  batchRetryProcessed:number;batchRetryRequeued:number;batchRetrySkipped:number;batchRetryFailed:number;batchRetryUnknown:number;batchRetryReconciled:number;
}
const statement=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);

async function expire(env:RuntimeEnv,at:number):Promise<void>{
  await statement(env,`UPDATE async_export_notification_retry_batches SET state='expired',version=version+1,updated_at=MAX(updated_at+1,?),completed_at=COALESCE(completed_at,?)
    WHERE id IN(SELECT id FROM async_export_notification_retry_batches WHERE cancelled_at IS NULL AND((state='preview' AND preview_expires_at<=?)
      OR(state IN('queued','running') AND expires_at<=?)) ORDER BY expires_at,id LIMIT 20) RETURNING id`,at,at,at,at).all();
}
async function candidate(env:RuntimeEnv,at:number):Promise<Item|null>{
  return statement(env,`SELECT i.*,b.state batch_state,b.expires_at batch_expires_at FROM async_export_notification_retry_items i
    JOIN async_export_notification_retry_batches b ON b.id=i.batch_id AND b.mailbox_id=i.mailbox_id
    WHERE b.state IN('queued','running','expired') AND b.committed_at IS NOT NULL
      AND((b.cancelled_at IS NULL AND(i.state='pending' OR(i.state='running' AND i.lease_until<=?))) OR(i.state='unknown' AND i.updated_at<=?))
    ORDER BY b.updated_at,b.id,i.updated_at,i.delivery_id LIMIT 1`,at,at-RECONCILE_DELAY_MS).first<Item>();
}
async function claim(env:RuntimeEnv,item:Item,at:number):Promise<Item|null>{
  const token=crypto.randomUUID();
  const changed=await env.DB.batch([statement(env,`UPDATE async_export_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=MAX(updated_at+1,?)
    WHERE batch_id=? AND mailbox_id=? AND delivery_id=? AND version=? AND(state='pending' OR(state='running' AND lease_until<=?))
      AND EXISTS(SELECT 1 FROM async_export_notification_retry_batches b WHERE b.id=async_export_notification_retry_items.batch_id AND b.mailbox_id=async_export_notification_retry_items.mailbox_id AND b.state IN('queued','running','expired') AND b.committed_at IS NOT NULL AND b.cancelled_at IS NULL)
    RETURNING *`,token,at+LEASE_MS,at,item.batch_id,item.mailbox_id,item.delivery_id,item.version,at),
    exportRetryBatchSyncStatement(env,item.batch_id,at,{mailboxId:item.mailbox_id,deliveryId:item.delivery_id,leaseToken:token,itemVersion:item.version+1})]);
  const row=changed[0].results[0] as unknown as Omit<Item,'batch_state'|'batch_expires_at'>|undefined;
  return row?{...row,batch_state:item.batch_state,batch_expires_at:item.batch_expires_at}:null;
}
async function syncBatch(env:RuntimeEnv,item:{batch_id:string;mailbox_id:string},at:number):Promise<void>{await exportRetryBatchSyncStatement(env,item.batch_id,at).run();}
async function checkpoint(env:RuntimeEnv,item:Item,state:ResultState,reason:AsyncExportRetryBatchItemReason|null,manualId:string|null,at:number):Promise<boolean>{
  const running=item.state==='running';
  const result=await env.DB.batch([statement(env,`UPDATE async_export_notification_retry_items SET state=?,reason=?,manual_retry_id=COALESCE(manual_retry_id,?),
    completed_at=COALESCE(completed_at,?),lease_token=NULL,lease_until=NULL,version=version+1,updated_at=MAX(updated_at+1,?)
    WHERE batch_id=? AND mailbox_id=? AND delivery_id=? AND version=? AND state=? ${running?'AND lease_token=? AND lease_until>?':''} RETURNING delivery_id`,
    state,reason,manualId,at,at,item.batch_id,item.mailbox_id,item.delivery_id,item.version,item.state,...(running?[item.lease_token,at]:[])),exportRetryBatchSyncStatement(env,item.batch_id,at)]);
  return result[0].results.length===1;
}
function count(result:AsyncExportNotificationRetryBatchJobResult,state:ResultState,reconciled=false){
  if(reconciled)result.batchRetryReconciled++;else result.batchRetryProcessed++;
  if(state==='requeued')result.batchRetryRequeued++;else if(state==='skipped')result.batchRetrySkipped++;else if(state==='failed')result.batchRetryFailed++;else result.batchRetryUnknown++;
}
function ownerContext(env:RuntimeEnv,item:Item):OwnerContext{
  // Execution is delegated by the immutable Owner-confirmed batch, never by an unauthenticated request.
  // The single-delivery audit remains an Owner operation performed on that recorded intent's behalf.
  return {env,actor:{kind:'owner',email:env.OWNER_EMAIL},requestId:`export-retry-batch:${item.batch_id}:${item.delivery_id}`};
}
async function receipt(env:RuntimeEnv,item:Item){return findAsyncExportNotificationRetryReceipt(env,item.mailbox_id,item.job_id,item.delivery_id,item.client_request_id,item.expected_updated_at);}
async function blocked(env:RuntimeEnv,item:Item,error:ServiceError):Promise<{state:ResultState;reason:AsyncExportRetryBatchItemReason}>{
  const mailbox=await statement(env,'SELECT status FROM mailboxes WHERE id=?',item.mailbox_id).first<{status:string}>();
  if(!mailbox||mailbox.status!=='active')return {state:'skipped',reason:'mailbox_inactive'};
  const batch=await statement(env,'SELECT state,expires_at,cancelled_at FROM async_export_notification_retry_batches WHERE id=?',item.batch_id).first<{state:string;expires_at:number;cancelled_at:number|null}>();
  if(batch?.cancelled_at!==null&&batch?.cancelled_at!==undefined)return {state:'skipped',reason:'batch_cancelled'};
  if(!batch||batch.state==='expired'||batch.expires_at<=Date.now())return {state:'skipped',reason:'batch_expired'};
  if(error.code==='export_notification_retry_conflict')return {state:'failed',reason:'receipt_conflict'};
  if(error.code==='not_found')return {state:'skipped',reason:'not_found'};
  const current=await getAsyncExportNotificationDelivery(ownerContext(env,item),item.mailbox_id,item.job_id,item.delivery_id);
  if(current.delivery.updatedAt!==item.expected_updated_at)return {state:'skipped',reason:'changed'};
  const reason=current.delivery.retry.reason??(error.code==='export_notification_retry_changed'?'changed':'signing_key_unavailable');
  return {state:['payload_unavailable','invalid_target','signing_key_unavailable'].includes(reason)?'failed':'skipped',reason};
}
async function reconcile(env:RuntimeEnv,item:Item,now:()=>number,result:AsyncExportNotificationRetryBatchJobResult):Promise<void>{
  try{
    const found=await receipt(env,item);
    if(found){if(await checkpoint(env,item,'requeued',null,found.id,now()))count(result,'requeued',true);}
    else await checkpoint(env,item,'unknown','result_unknown',null,now());
  }catch{console.error(JSON.stringify({event:'export_retry_batch_reconcile_unavailable'}));}
}
async function process(env:RuntimeEnv,original:Item,now:()=>number,result:AsyncExportNotificationRetryBatchJobResult):Promise<void>{
  if(original.state==='unknown'){await reconcile(env,original,now,result);return;}
  const item=await claim(env,original,now());if(!item)return;
  let outcome:ResultState='unknown',reason:AsyncExportRetryBatchItemReason|null='result_unknown',manualId:string|null=null;
  try{
    const prior=await receipt(env,item);
    if(prior){outcome='requeued';reason=null;manualId=prior.id;}
    else if(original.state==='running'){
      // A crashed executor may have crossed the external D1 commit boundary. Never blindly repeat it.
      outcome='unknown';reason='result_unknown';
    }else if(original.batch_state==='expired'||original.batch_expires_at<=now()){outcome='skipped';reason='batch_expired';}
    else if(!item.preview_eligible){outcome='skipped';reason=item.preview_reason??'preview_blocked';}
    else{
      const retried=await retryAsyncExportNotificationDelivery(ownerContext(env,item),item.mailbox_id,item.job_id,item.delivery_id,
        {clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at},
        {batchGuard:{batchId:item.batch_id,leaseToken:item.lease_token!,itemVersion:item.version}});
      outcome='requeued';reason=null;manualId=retried.manualRetry.id;
    }
  }catch(error){
    try{
      // Even a validation/retirement error may follow a committed single-delivery receipt.
      const committed=await receipt(env,item);
      if(committed){outcome='requeued';reason=null;manualId=committed.id;}
      else if(error instanceof ServiceError){const classification=await blocked(env,item,error);outcome=classification.state;reason=classification.reason;}
    }catch{/* Unknown stays explicit until a later read-only receipt reconciliation. */}
  }
  try{if(await checkpoint(env,item,outcome,reason,manualId,now()))count(result,outcome);}
  catch{console.error(JSON.stringify({event:'export_retry_batch_checkpoint_unavailable'}));}
}
async function repair(env:RuntimeEnv,at:number):Promise<void>{
  // Bounded repair also closes empty jobs and repairs a crash after an item receipt but before progress aggregation.
  const rows=(await statement(env,`SELECT b.id batch_id,b.mailbox_id FROM async_export_notification_retry_batches b
    WHERE((b.state IN('queued','running','expired') AND b.committed_at IS NOT NULL) OR b.cancelled_at IS NOT NULL)
      AND((b.cancelled_at IS NULL AND b.total_items=0 AND b.state IN('queued','running')) OR b.processed_items<>(SELECT COUNT(*) FROM async_export_notification_retry_items i WHERE i.batch_id=b.id AND i.mailbox_id=b.mailbox_id AND i.state IN('requeued','skipped','failed','unknown'))
        OR b.requeued_items<>(SELECT COUNT(*) FROM async_export_notification_retry_items i WHERE i.batch_id=b.id AND i.mailbox_id=b.mailbox_id AND i.state='requeued')
        OR b.unknown_items<>(SELECT COUNT(*) FROM async_export_notification_retry_items i WHERE i.batch_id=b.id AND i.mailbox_id=b.mailbox_id AND i.state='unknown'))
    ORDER BY b.updated_at,b.id LIMIT 5`).all<{batch_id:string;mailbox_id:string}>()).results;
  for(const item of rows)await syncBatch(env,item,at);
}
/** At most five scoped item operations, no HTTP transport and no re-evaluation of skipped notification admission. */
export async function runAsyncExportNotificationRetryBatchJobs(env:RuntimeEnv,options:AsyncExportNotificationRetryBatchJobOptions={}):Promise<AsyncExportNotificationRetryBatchJobResult>{
  const max=options.maxItems??5;if(!Number.isSafeInteger(max)||max<1||max>5)throw new ServiceError('invalid_query',400);
  const now=options.now??Date.now,result:AsyncExportNotificationRetryBatchJobResult={batchRetryProcessed:0,batchRetryRequeued:0,batchRetrySkipped:0,batchRetryFailed:0,batchRetryUnknown:0,batchRetryReconciled:0};
  await expire(env,now());await repair(env,now());
  for(let index=0;index<max;index++){const next=await candidate(env,now());if(!next)break;await process(env,next,now,result);}
  return result;
}
