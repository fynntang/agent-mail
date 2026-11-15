import type {AlertNotificationExport} from '../../types/alert-notification-export';
import {ServiceError} from './types';

export const ALERT_NOTIFICATION_EXPORT_MAX_BYTES=8*1024*1024;
export const ALERT_NOTIFICATION_CSV_COLUMNS=[
  'row_type','metric','value','event_id','alert_id','decision','policy_version','decided_at_utc','event_available','event_type','kind','outcome','error_code','occurred_at_utc',
  'delivery_id','endpoint_id','delivery_state','attempts','attempt_budget','available_at_utc','last_http_status','last_error_code','secret_version','created_at_utc','updated_at_utc','completed_at_utc',
  'delivery_total','delivery_pending','delivery_running','delivery_succeeded','delivery_dead','delivery_cancelled','delivery_attempts','delivery_quiet_deferred'
] as const;
export type AlertNotificationCsvCell=string|number|boolean|null|undefined;
type Cell=AlertNotificationCsvCell;
export type AlertNotificationCsvRow=Partial<Record<typeof ALERT_NOTIFICATION_CSV_COLUMNS[number],Cell>>;
type CsvRow=AlertNotificationCsvRow;
/** Quoting protects CSV structure. An apostrophe separately prevents spreadsheet formula execution. */
export function alertNotificationCsvCell(value:Cell):string{
  let text=value===null||value===undefined?'':String(value);
  const start=text.replace(/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]+/u,'');
  if(/^[=+\-@]/.test(start)||/^[\t\r\n]/.test(text))text="'"+text;
  return `"${text.replaceAll('"','""')}"`;
}
function utc(value:number|null):string{
  if(value===null)return '';const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():String(value);
}
export function* alertNotificationCsvPreambleRows(data:AlertNotificationExport):Generator<CsvRow>{
  const metadata:Record<string,Cell>={version:data.version,generated_at_utc:utc(data.generatedAt),mailbox_id:data.mailboxId,
    'window.from_utc':utc(data.window.from),'window.to_utc':utc(data.window.to),'filters.decision':data.filters.decision,
    'filters.event_type':data.filters.eventType,'snapshot.decision_watermark':data.snapshot.decisionWatermark};
  for(const [metric,value] of Object.entries(metadata))yield {row_type:'metadata',metric,value};
  for(const metric of ['total','allowed','skipped'] as const)yield {row_type:'summary',metric,value:data.summary[metric]};
  for(const [reason,value] of Object.entries(data.summary.byDecision))yield {row_type:'summary',metric:`by_decision.${reason}`,value};
  for(const [counter,value] of Object.entries(data.summary.delivery))yield {row_type:'summary',metric:`delivery.${counter}`,value};
}
export function* alertNotificationCsvDecisionRows(items:AlertNotificationExport['decisions']):Generator<CsvRow>{
  for(const item of items){
    yield {row_type:'decision',event_id:item.eventId,alert_id:item.alertId,decision:item.decision,policy_version:item.policyVersion,
      decided_at_utc:utc(item.decidedAt),event_available:item.eventAvailable,event_type:item.eventType,kind:item.kind,outcome:item.outcome,
      error_code:item.errorCode,occurred_at_utc:utc(item.occurredAt),delivery_total:item.delivery.total,delivery_pending:item.delivery.pending,
      delivery_running:item.delivery.running,delivery_succeeded:item.delivery.succeeded,delivery_dead:item.delivery.dead,delivery_cancelled:item.delivery.cancelled,
      delivery_attempts:item.delivery.attempts,delivery_quiet_deferred:item.delivery.quietDeferred};
    for(const delivery of item.deliveries)yield {row_type:'delivery',event_id:item.eventId,alert_id:item.alertId,
      delivery_id:delivery.id,endpoint_id:delivery.endpointId,delivery_state:delivery.state,attempts:delivery.attempts,attempt_budget:delivery.attemptBudget,
      available_at_utc:utc(delivery.availableAt),last_http_status:delivery.lastHttpStatus,last_error_code:delivery.lastErrorCode,secret_version:delivery.secretVersion,
      created_at_utc:utc(delivery.createdAt),updated_at_utc:utc(delivery.updatedAt),completed_at_utc:utc(delivery.completedAt)};
  }
}
export function alertNotificationCsvLine(row:CsvRow):string{return ALERT_NOTIFICATION_CSV_COLUMNS.map(column=>alertNotificationCsvCell(row[column])).join(',')+'\r\n';}
/** Serialize completely before returning a download, so size failures never yield a partial attachment. */
export function formatAlertNotificationExport(data:AlertNotificationExport,format:'csv'|'json'):Uint8Array<ArrayBuffer>{
  const encoder=new TextEncoder();
  if(format==='json'){
    const bytes=encoder.encode(JSON.stringify(data));if(bytes.byteLength>ALERT_NOTIFICATION_EXPORT_MAX_BYTES)throw new ServiceError('alert_notification_export_too_large',413);return new Uint8Array(bytes);
  }
  const chunks:Uint8Array[]=[encoder.encode('\uFEFF')];let length=chunks[0].byteLength;
  const append=(row:readonly Cell[])=>{
    const bytes=encoder.encode(row.map(alertNotificationCsvCell).join(',')+'\r\n');length+=bytes.byteLength;
    if(length>ALERT_NOTIFICATION_EXPORT_MAX_BYTES)throw new ServiceError('alert_notification_export_too_large',413);chunks.push(bytes);
  };
  append(ALERT_NOTIFICATION_CSV_COLUMNS);
  for(const row of alertNotificationCsvPreambleRows(data))append(ALERT_NOTIFICATION_CSV_COLUMNS.map(column=>row[column]));
  for(const row of alertNotificationCsvDecisionRows(data.decisions))append(ALERT_NOTIFICATION_CSV_COLUMNS.map(column=>row[column]));
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
