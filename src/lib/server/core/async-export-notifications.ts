import type {AsyncExportNotification,AsyncExportNotificationList,AsyncExportNotificationDecision} from '../../types/async-export-notifications';
import {ASYNC_ALERT_NOTIFICATION_EXPORT_ERRORS} from './async-alert-notification-exports';
import {stableId} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decisions:AsyncExportNotificationDecision[]=['allowed','disabled','quiet_hours','repeat_limited','no_subscribers'];
export interface AsyncExportNotificationRow {
  job_id:string;mailbox_id:string;outcome:'succeeded'|'failed';format:'csv'|'json';total_decisions:number;processed_decisions:number;processed_deliveries:number;
  body_bytes:number;error_code:string|null;completed_at:number;expires_at:number;created_at:number;acknowledged_at:number|null;version:number;
  event_id:string|null;projected_at:number|null;notification_decision:AsyncExportNotificationDecision|null;policy_version:number|null;decided_at:number|null;claim_token:string|null;
}
const safeError=(code:string|null)=>code&&(ASYNC_ALERT_NOTIFICATION_EXPORT_ERRORS as readonly string[]).includes(code)?code:null;
export function asyncExportNotificationDto(row:AsyncExportNotificationRow):AsyncExportNotification {
  return {id:row.job_id,jobId:row.job_id,mailboxId:row.mailbox_id,outcome:row.outcome,format:row.format,totalDecisions:row.total_decisions,
    processedDecisions:row.processed_decisions,processedDeliveries:row.processed_deliveries,bodyBytes:row.body_bytes,errorCode:safeError(row.error_code),
    completedAt:row.completed_at,expiresAt:row.expires_at,createdAt:row.created_at,acknowledgedAt:row.acknowledged_at,version:row.version,
    notificationDecision:row.notification_decision&&decisions.includes(row.notification_decision)?row.notification_decision:null,policyVersion:row.policy_version,decidedAt:row.decided_at};
}
async function authorize(ctx:OwnerContext,box:string):Promise<void>{
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
}
async function row(ctx:OwnerContext,box:string,id:string):Promise<AsyncExportNotificationRow>{
  await authorize(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);
  const item=await ctx.env.DB.prepare('SELECT * FROM async_export_notifications WHERE mailbox_id=? AND job_id=?').bind(box,id).first<AsyncExportNotificationRow>();
  if(!item)throw new ServiceError('not_found',404);return item;
}
export async function getAsyncExportNotification(ctx:OwnerContext,box:string,id:string):Promise<{notification:AsyncExportNotification}>{
  return {notification:asyncExportNotificationDto(await row(ctx,box,id))};
}
export async function listAsyncExportNotifications(ctx:OwnerContext,box:string,query:{status?:unknown;limit?:unknown;cursor?:unknown}={}):Promise<AsyncExportNotificationList>{
  await authorize(ctx,box);objectInput(query,['status','limit','cursor']);const status=query.status??'unread',limit=query.limit===undefined?20:Number(query.limit);
  if(typeof status!=='string'||!['unread','acknowledged','all'].includes(status)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let before:{time:number;id:string}|null=null;
  if(query.cursor!==undefined){try{
    if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const cursor=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!cursor||Object.keys(cursor).length!==6||cursor.v!==1||cursor.box!==box||cursor.status!==status||cursor.limit!==limit
      ||!Number.isSafeInteger(cursor.time)||cursor.time<0||typeof cursor.id!=='string'||!uuid.test(cursor.id))throw Error();
    before={time:cursor.time,id:cursor.id};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const filter=status==='all'?'':status==='unread'?'AND acknowledged_at IS NULL':'AND acknowledged_at IS NOT NULL';
  const snapshot=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT * FROM async_export_notifications WHERE mailbox_id=? ${filter} ${before?'AND(created_at<? OR(created_at=? AND job_id<?))':''}
      ORDER BY created_at DESC,job_id DESC LIMIT ?`).bind(box,...(before?[before.time,before.time,before.id]:[]),limit+1),
    ctx.env.DB.prepare(`SELECT COALESCE(SUM(acknowledged_at IS NULL),0) unread,COALESCE(SUM(outcome='succeeded'),0) succeeded,
      COALESCE(SUM(outcome='failed'),0) failed FROM async_export_notifications WHERE mailbox_id=?`).bind(box)
  ]);
  const items=snapshot[0].results as unknown as AsyncExportNotificationRow[],visible=items.slice(0,limit),last=visible.at(-1);
  const nextCursor=items.length>limit&&last?btoa(JSON.stringify({v:1,box,status,limit,time:last.created_at,id:last.job_id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {notifications:visible.map(asyncExportNotificationDto),nextCursor,summary:snapshot[1].results[0] as unknown as AsyncExportNotificationList['summary']};
}
export async function acknowledgeAsyncExportNotification(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<{notification:AsyncExportNotification}>{
  const current=await row(ctx,box,id),data=objectInput(input,['expectedVersion']);
  if(typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ServiceError('invalid_input',400);
  if(data.expectedVersion!==current.version||current.acknowledged_at!==null)throw new ServiceError('export_notification_changed',409);
  const at=Math.max(Date.now(),current.created_at),mutation=crypto.randomUUID();
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','async_export_notification.acknowledged',?,'success',?,? WHERE EXISTS(
        SELECT 1 FROM async_export_notifications n JOIN mailboxes m ON m.id=n.mailbox_id
        WHERE n.job_id=? AND n.mailbox_id=? AND n.version=? AND n.acknowledged_at IS NULL AND m.status IN('active','paused'))`)
      .bind(mutation,box,id,ctx.requestId,at,id,box,current.version),
    ctx.env.DB.prepare(`UPDATE async_export_notifications SET acknowledged_at=?,version=version+1 WHERE job_id=? AND mailbox_id=?
      AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(at,id,box,mutation)
  ]);
  if(result[1].meta.changes!==1)throw new ServiceError('export_notification_changed',409);
  return getAsyncExportNotification(ctx,box,id);
}
/** Owner-wide count remains independent of Cloudflare credentials and Webhook delivery policy. */
export async function exportNotice(ctx:OwnerContext):Promise<{count:number;mailboxId:string}|null>{
  requireOwner(ctx.actor);
  const item=await ctx.env.DB.prepare(`WITH visible AS(SELECT n.job_id,n.mailbox_id,n.created_at FROM async_export_notifications n JOIN mailboxes m ON m.id=n.mailbox_id
      WHERE n.acknowledged_at IS NULL AND m.status IN('active','paused'))
    SELECT COUNT(*) count,(SELECT mailbox_id FROM visible ORDER BY created_at DESC,job_id DESC LIMIT 1) mailboxId FROM visible`).first<{count:number;mailboxId:string|null}>();
  return item&&item.count>0&&item.mailboxId?{count:item.count,mailboxId:item.mailboxId}:null;
}
/** Bounded durable outbox projection. Source creation time fences later subscriptions. */
export async function projectAsyncExportNotifications(env:RuntimeEnv,options:{now?:()=>number}={}):Promise<{exportNotificationsProjected:number}>{
  const now=options.now??Date.now,items=(await env.DB.prepare(`SELECT n.* FROM async_export_notifications n JOIN mailboxes m ON m.id=n.mailbox_id
    WHERE n.projected_at IS NULL AND m.status IN('active','paused') ORDER BY n.created_at,n.job_id LIMIT 20`).all<AsyncExportNotificationRow>()).results;
  let count=0;
  for(const item of items){
    const eventId=await stableId(`async-export-notification:v1:${item.job_id}`),type=`alert_notification.export.${item.outcome}`;
    const payload=JSON.stringify({jobId:item.job_id,format:item.format,state:item.outcome,totalDecisions:item.total_decisions,processedDecisions:item.processed_decisions,
      processedDeliveries:item.processed_deliveries,bodyBytes:item.body_bytes,completedAt:item.completed_at,expiresAt:item.expires_at,errorCode:safeError(item.error_code)});
    const source=`async-export-notification:v1:${item.job_id}`,at=Math.max(now(),item.created_at);
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
        SELECT ?,mailbox_id,'app',?,?,?,?,created_at FROM async_export_notifications n WHERE job_id=? AND mailbox_id=? AND projected_at IS NULL
          AND EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=n.mailbox_id AND m.status IN('active','paused')) ON CONFLICT(id) DO NOTHING`)
        .bind(eventId,source,type,payload,item.completed_at,item.job_id,item.mailbox_id),
      env.DB.prepare(`UPDATE async_export_notifications SET event_id=?,projected_at=? WHERE job_id=? AND mailbox_id=? AND projected_at IS NULL
        AND EXISTS(SELECT 1 FROM events e WHERE e.id=? AND e.mailbox_id=async_export_notifications.mailbox_id AND e.source='app'
          AND e.source_event_id=? AND e.type=? AND e.payload_json=? AND e.occurred_at=async_export_notifications.completed_at AND e.created_at=async_export_notifications.created_at)`)
        .bind(eventId,at,item.job_id,item.mailbox_id,eventId,source,type,payload)
    ]);count+=result[1].meta.changes;
  }
  return {exportNotificationsProjected:count};
}
