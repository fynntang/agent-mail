import type {AlertNotificationExport,AlertNotificationExportQuery} from '../../types/alert-notification-export';
import type {AlertNotificationDecisionReason,AlertNotificationDeliverySummary} from '../../types/alert-notification-decisions';
import {ALERT_NOTIFICATION_DECISIONS,authorizeNotificationDecisionRead,prepareNotificationDecisionRead,notificationDecisionFilter,
  notificationDecisionSelect,emptyNotificationDeliverySummary,notificationDecisionDto,notificationDeliveryDto,
  type NotificationDecisionRow,type NotificationDeliveryRow} from './alert-notification-decisions';
import {objectInput} from './outbound-content';
import type {OwnerContext} from './owner';
import {ServiceError} from './types';

export const ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS=1000,ALERT_NOTIFICATION_EXPORT_MAX_DELIVERIES=5000;

/** Complete bounded export, with a single transaction for immutable decisions and current delivery results. */
export async function exportAlertNotificationDecisions(ctx:OwnerContext,box:string,query:AlertNotificationExportQuery={}):Promise<AlertNotificationExport>{
  await authorizeNotificationDecisionRead(ctx,box);objectInput(query,['decision','eventType','from','to']);
  const p=await prepareNotificationDecisionRead(ctx,box,query),f=notificationDecisionFilter(p),args=[box,...f.args];
  const snapshot=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`${notificationDecisionSelect} WHERE ${f.where} ORDER BY n.decided_at DESC,n.event_id DESC LIMIT ?`)
      .bind(...args,ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS+1),
    ctx.env.DB.prepare(`SELECT COUNT(*) total,${ALERT_NOTIFICATION_DECISIONS.map(reason=>`COALESCE(SUM(n.decision='${reason}'),0) ${reason}`).join(',')}
      FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id WHERE ${f.where}`).bind(...args),
    ctx.env.DB.prepare(`SELECT id,mailbox_id,endpoint_id,event_id,state,attempts,attempt_budget,available_at,last_http_status,last_error_code,
      signed_secret_version,created_at,updated_at,completed_at FROM webhook_deliveries WHERE mailbox_id=? AND event_id IN(
        SELECT n.event_id FROM alert_notification_decisions n JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id WHERE ${f.where})
      ORDER BY event_id,created_at DESC,id DESC LIMIT ?`).bind(box,...args,ALERT_NOTIFICATION_EXPORT_MAX_DELIVERIES+1)
  ]);
  const rows=snapshot[0].results as unknown as NotificationDecisionRow[],count=snapshot[1].results[0] as unknown as {total:number;allowed:number}&Record<AlertNotificationDecisionReason,number>,
    deliveries=snapshot[2].results as unknown as NotificationDeliveryRow[];
  if(rows.length>ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS||count.total>ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS||deliveries.length>ALERT_NOTIFICATION_EXPORT_MAX_DELIVERIES)
    throw new ServiceError('alert_notification_export_too_large',413);
  const delivery=emptyNotificationDeliverySummary(),groups=new Map<string,{rows:NotificationDeliveryRow[];summary:AlertNotificationDeliverySummary}>();
  for(const row of deliveries){
    let group=groups.get(row.event_id);if(!group){group={rows:[],summary:emptyNotificationDeliverySummary()};groups.set(row.event_id,group);}group.rows.push(row);
    for(const summary of [delivery,group.summary]){summary.total++;summary[row.state]++;summary.attempts+=row.attempts;
      if(row.state==='pending'&&row.last_error_code==='alert_quiet_hours')summary.quietDeferred++;}
  }
  return {version:1,generatedAt:Date.now(),mailboxId:box,window:{from:p.from,to:p.to},
    filters:{decision:p.decision as AlertNotificationExport['filters']['decision'],eventType:p.eventType as AlertNotificationExport['filters']['eventType']},
    snapshot:{decisionWatermark:p.watermark},summary:{total:count.total,allowed:count.allowed,skipped:count.total-count.allowed,
      byDecision:Object.fromEntries(ALERT_NOTIFICATION_DECISIONS.map(reason=>[reason,count[reason]])) as Record<AlertNotificationDecisionReason,number>,delivery},
    decisions:rows.map(row=>{const group=groups.get(row.event_id),item=notificationDecisionDto(row,group?.summary??emptyNotificationDeliverySummary());
      return {...item,deliveries:(group?.rows??[]).map(result=>notificationDeliveryDto(result,item.eventType))};})};
}
