import type {AlertNotificationDecision,AlertNotificationDecisionDetail,AlertNotificationDecisionList,AlertNotificationDecisionReason,AlertNotificationDeliverySummary} from '../../types/alert-notification-decisions';
import type {WebhookDelivery} from '../../types/webhooks';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError} from './types';
import {webhookEventDto,type WebhookEventRow} from './webhooks';

export const ALERT_NOTIFICATION_DECISIONS:AlertNotificationDecisionReason[]=['allowed','disabled','quiet_hours','repeat_limited','recovery_disabled','no_subscribers'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY=86_400_000,MAX_WINDOW=31*DAY;
type Query={decision?:unknown;eventType?:unknown;from?:unknown;to?:unknown;limit?:unknown;cursor?:unknown};
interface Page {decision:string;eventType:string;from:number;to:number;limit:number;watermark:number;before:{time:number;id:string}|null}
interface DecisionRow extends WebhookEventRow {
  event_id:string;alert_id:string;decision:AlertNotificationDecisionReason;policy_version:number;decided_at:number;
}
interface DeliveryRow {id:string;mailbox_id:string;endpoint_id:string;event_id:string;state:WebhookDelivery['state'];attempts:number;attempt_budget:number;available_at:number;
  last_http_status:number|null;last_error_code:string|null;signed_secret_version:number;created_at:number;updated_at:number;completed_at:number|null}
const selectDecision=`SELECT n.event_id,n.alert_id,n.decision,n.policy_version,n.decided_at,e.id,e.mailbox_id,e.source,e.type,e.payload_json,e.occurred_at,e.created_at
  FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id`;
const counters=`COUNT(*) total,COALESCE(SUM(state='pending'),0) pending,COALESCE(SUM(state='running'),0) running,
  COALESCE(SUM(state='succeeded'),0) succeeded,COALESCE(SUM(state='dead'),0) dead,COALESCE(SUM(state='cancelled'),0) cancelled,
  COALESCE(SUM(attempts),0) attempts,COALESCE(SUM(state='pending' AND last_error_code='alert_quiet_hours'),0) quietDeferred`;
const zeroDelivery=():AlertNotificationDeliverySummary=>({total:0,pending:0,running:0,succeeded:0,dead:0,cancelled:0,attempts:0,quietDeferred:0});
const safeDeliveryErrors=new Set(['lease_expired','lease_lost','invalid_target','payload_unavailable','signing_key_unavailable','mailbox_inactive','endpoint_inactive',
  'http_retry','http_rejected','delivery_timeout','network_error','alert_notifications_disabled','alert_recovery_disabled','alert_quiet_hours','legacy_snapshot_unavailable']);
async function authorize(ctx:OwnerContext,box:string):Promise<void>{
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
}
function integer(value:unknown):number{
  if(typeof value!=='number'&&(typeof value!=='string'||!/^\d{1,16}$/.test(value)))throw new ServiceError('invalid_query',400);
  const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new ServiceError('invalid_query',400);return number;
}
function decode(value:unknown,box:string):Record<string,unknown>{
  try{
    if(typeof value!=='string'||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
    const row=JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/')));
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==10||row.v!==1||row.box!==box
      ||!Number.isSafeInteger(row.watermark)||row.watermark<0||!Number.isSafeInteger(row.time)||row.time<0
      ||!Number.isSafeInteger(row.from)||row.from<0||!Number.isSafeInteger(row.to)||row.to<=row.from||row.to-row.from>MAX_WINDOW
      ||!Number.isSafeInteger(row.limit)||row.limit<1||row.limit>100||!['all',...ALERT_NOTIFICATION_DECISIONS].includes(row.decision)
      ||!['all','created','resolved'].includes(row.eventType)
      ||typeof row.id!=='string'||!uuid.test(row.id))throw Error();return row;
  }catch{throw new ServiceError('invalid_cursor',400);}
}
async function page(ctx:OwnerContext,box:string,query:Query):Promise<Page>{
  objectInput(query,['decision','eventType','from','to','limit','cursor']);
  const decision=query.decision??'all',eventType=query.eventType??'all',limit=query.limit===undefined?20:integer(query.limit);
  if(typeof decision!=='string'||!['all',...ALERT_NOTIFICATION_DECISIONS].includes(decision)||!['all','created','resolved'].includes(String(eventType))
    ||typeof eventType!=='string'||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  const cursor=query.cursor===undefined?null:decode(query.cursor,box),to=query.to===undefined?(cursor?integer(cursor.to):Date.now()+1):integer(query.to),
    from=query.from===undefined?(cursor?integer(cursor.from):Math.max(0,to-7*DAY)):integer(query.from);
  if(from>=to||to-from>MAX_WINDOW||to>Date.now()+60_000)throw new ServiceError('invalid_query',400);
  if(cursor&&(cursor.decision!==decision||cursor.eventType!==eventType||cursor.limit!==limit||cursor.from!==from||cursor.to!==to
    ||Number(cursor.time)<from||Number(cursor.time)>=to))throw new ServiceError('invalid_cursor',400);
  const watermark=cursor?Number(cursor.watermark):Number(await ctx.env.DB.prepare('SELECT COALESCE(MAX(rowid),0) watermark FROM alert_notification_decisions WHERE mailbox_id=?').bind(box).first('watermark'));
  return {decision,eventType,from,to,limit,watermark,before:cursor?{time:Number(cursor.time),id:String(cursor.id)}:null};
}
function filter(p:Page):{where:string;args:(string|number)[]}{
  return {where:`n.mailbox_id=? AND n.rowid<=? AND n.decided_at>=? AND n.decided_at<?${p.decision==='all'?'':' AND n.decision=?'}${p.eventType==='all'?'':' AND e.type=?'}`,
    args:[p.watermark,p.from,p.to,...(p.decision==='all'?[]:[p.decision]),...(p.eventType==='all'?[]:[`cloudflare.suppression.alert.${p.eventType}`])]};
}
function decisionDto(row:DecisionRow,delivery:AlertNotificationDeliverySummary):AlertNotificationDecision{
  const parsed=webhookEventDto(row),event=parsed&&['cloudflare.suppression.alert.created','cloudflare.suppression.alert.resolved'].includes(parsed.type)&&parsed.data.alertId===row.alert_id?parsed:null;
  return {eventId:row.event_id,alertId:row.alert_id,decision:row.decision,policyVersion:row.policy_version,decidedAt:row.decided_at,eventAvailable:event!==null,
    eventType:event?(event.type.endsWith('.resolved')?'resolved':'created'):null,kind:event?.data.kind==='sync'||event?.data.kind==='release'?event.data.kind:null,outcome:event?.data.outcome??null,
    errorCode:event?.data.errorCode??null,occurredAt:event?.occurredAt??null,delivery};
}
function deliveryDto(d:DeliveryRow,eventType:AlertNotificationDecision['eventType']):WebhookDelivery{
  return {id:d.id,mailboxId:d.mailbox_id,endpointId:d.endpoint_id,eventId:d.event_id,
    eventType:eventType?`cloudflare.suppression.alert.${eventType}` as WebhookDelivery['eventType']:'unknown',state:d.state,
    attempts:d.attempts,attemptBudget:d.attempt_budget,availableAt:d.available_at,lastHttpStatus:d.last_http_status,
    lastErrorCode:d.last_error_code&&safeDeliveryErrors.has(d.last_error_code)?d.last_error_code:null,secretVersion:d.signed_secret_version,
    createdAt:d.created_at,updatedAt:d.updated_at,completedAt:d.completed_at};
}
function cursor(box:string,p:Page,row:DecisionRow):string{
  return btoa(JSON.stringify({v:1,box,decision:p.decision,eventType:p.eventType,from:p.from,to:p.to,limit:p.limit,watermark:p.watermark,time:row.decided_at,id:row.event_id}))
    .replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function listAlertNotificationDecisions(ctx:OwnerContext,box:string,query:Query={}):Promise<AlertNotificationDecisionList>{
  await authorize(ctx,box);const p=await page(ctx,box,query),f=filter(p),args=[box,...f.args];
  const before=p.before?' AND(n.decided_at<? OR(n.decided_at=? AND n.event_id<?))':'';
  const rows=(await ctx.env.DB.prepare(`${selectDecision} WHERE ${f.where}${before} ORDER BY n.decided_at DESC,n.event_id DESC LIMIT ?`)
    .bind(...args,...(p.before?[p.before.time,p.before.time,p.before.id]:[]),p.limit+1).all<DecisionRow>()).results;
  const visible=rows.slice(0,p.limit),ids=JSON.stringify(visible.map(row=>row.event_id));
  // Decisions are immutable and bounded by the watermark. Read all live delivery counters in one snapshot.
  const snapshot=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT event_id,${counters} FROM webhook_deliveries
      WHERE mailbox_id=? AND event_id IN(SELECT value FROM json_each(?)) GROUP BY event_id`).bind(box,ids),
    ctx.env.DB.prepare(`SELECT COUNT(*) total,${ALERT_NOTIFICATION_DECISIONS.map(value=>`COALESCE(SUM(n.decision='${value}'),0) ${value}`).join(',')}
      FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id WHERE ${f.where}`).bind(...args),
    ctx.env.DB.prepare(`SELECT ${counters} FROM webhook_deliveries WHERE mailbox_id=? AND event_id IN(
      SELECT n.event_id FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id WHERE ${f.where})`).bind(box,...args)
  ]);
  const deliveryRows=snapshot[0].results as unknown as (AlertNotificationDeliverySummary&{event_id:string})[];
  const deliveryById=new Map(deliveryRows.map(row=>{const {event_id,...summary}=row;return [event_id,summary] as const;}));
  const count=snapshot[1].results[0] as unknown as {total:number;allowed:number}&Record<AlertNotificationDecisionReason,number>;
  const delivery=snapshot[2].results[0] as unknown as AlertNotificationDeliverySummary;
  const byDecision=Object.fromEntries(ALERT_NOTIFICATION_DECISIONS.map(reason=>[reason,count[reason]])) as Record<AlertNotificationDecisionReason,number>;
  return {decisions:visible.map(row=>decisionDto(row,deliveryById.get(row.event_id)??zeroDelivery())),nextCursor:rows.length>p.limit?cursor(box,p,visible.at(-1)!):null,
    window:{from:p.from,to:p.to},summary:{total:count.total,allowed:count.allowed,skipped:count.total-count.allowed,byDecision,delivery:delivery??zeroDelivery()}};
}
export async function getAlertNotificationDecision(ctx:OwnerContext,box:string,id:string):Promise<AlertNotificationDecisionDetail>{
  await authorize(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);
  const row=await ctx.env.DB.prepare(`${selectDecision} WHERE n.mailbox_id=? AND n.event_id=?`).bind(box,id).first<DecisionRow>();if(!row)throw new ServiceError('not_found',404);
  const snapshot=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT ${counters} FROM webhook_deliveries WHERE mailbox_id=? AND event_id=?`).bind(box,id),
    ctx.env.DB.prepare(`SELECT id,mailbox_id,endpoint_id,event_id,state,attempts,attempt_budget,available_at,last_http_status,last_error_code,
      signed_secret_version,created_at,updated_at,completed_at FROM webhook_deliveries WHERE mailbox_id=? AND event_id=? ORDER BY created_at DESC,id DESC LIMIT 101`).bind(box,id)
  ]);
  const delivery=snapshot[0].results[0] as unknown as AlertNotificationDeliverySummary,results=snapshot[1].results as unknown as DeliveryRow[];
  const decision=decisionDto(row,delivery??zeroDelivery());
  return {decision,deliveries:results.slice(0,100).map(d=>deliveryDto(d,decision.eventType)),deliveriesTruncated:results.length>100};
}

// Export reads share the exact authorization, range filters and safe projections used by Owner history.
export {authorize as authorizeNotificationDecisionRead,page as prepareNotificationDecisionRead,filter as notificationDecisionFilter,
  selectDecision as notificationDecisionSelect,zeroDelivery as emptyNotificationDeliverySummary,
  decisionDto as notificationDecisionDto,deliveryDto as notificationDeliveryDto};
export type {DecisionRow as NotificationDecisionRow,DeliveryRow as NotificationDeliveryRow};
