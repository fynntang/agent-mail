import type {AlertNotificationExport} from '../../types/alert-notification-export';
import {ALERT_NOTIFICATION_CSV_COLUMNS,alertNotificationCsvCell,alertNotificationCsvDecisionRows,alertNotificationCsvLine,alertNotificationCsvPreambleRows} from './alert-notification-export-format';
import {ServiceError} from './types';

export const ASYNC_EXPORT_MAX_BYTES=256*1024*1024,ASYNC_EXPORT_ENVELOPE_RESERVE=64*1024,ASYNC_EXPORT_CHUNK_MAX_BYTES=8*1024*1024;
export type AsyncExportFormat='csv'|'json';
export interface AsyncExportEnvelopeSource{
  mailboxId:string;format:AsyncExportFormat;createdAt:number;startedAt:number|null;completedAt:number|null;
  window:AlertNotificationExport['window'];filters:AlertNotificationExport['filters'];snapshot:AlertNotificationExport['snapshot'];summary:AlertNotificationExport['summary'];
  observedFrom?:number|null;observedTo?:number|null;
}
/** Fragments are independently immutable. Their concatenation is one valid CSV/JSON file. */
export function formatAsyncExportChunk(items:AlertNotificationExport['decisions'],format:AsyncExportFormat,hasPrevious:boolean):Uint8Array<ArrayBuffer>{
  const text=format==='json'?(items.length?(hasPrevious?',':'')+items.map(item=>JSON.stringify(item)).join(','):''):
    [...alertNotificationCsvDecisionRows(items)].map(alertNotificationCsvLine).join('');
  const bytes=new TextEncoder().encode(text);if(bytes.byteLength>ASYNC_EXPORT_CHUNK_MAX_BYTES)throw new ServiceError('async_export_batch_too_large',413);
  return new Uint8Array(bytes);
}
export function formatAsyncExportEnvelope(job:AsyncExportEnvelopeSource):{prefix:Uint8Array<ArrayBuffer>;suffix:Uint8Array<ArrayBuffer>;bytes:number}{
  const data:AlertNotificationExport={version:1,generatedAt:job.completedAt??job.createdAt,mailboxId:job.mailboxId,window:job.window,filters:job.filters,
    snapshot:job.snapshot,summary:job.summary,decisions:[]};
  const processing={startedAt:job.startedAt,completedAt:job.completedAt,observedFrom:job.observedFrom??null,observedTo:job.observedTo??null,deliverySnapshot:'per_batch'};
  let prefix:string,suffix:string;
  if(job.format==='json'){
    const {decisions:_,...metadata}=data;prefix=JSON.stringify({...metadata,processing}).slice(0,-1)+',"decisions":[';suffix=']}';
  }else{
    prefix='\uFEFF'+ALERT_NOTIFICATION_CSV_COLUMNS.map(alertNotificationCsvCell).join(',')+'\r\n';
    for(const row of alertNotificationCsvPreambleRows(data))prefix+=alertNotificationCsvLine(row);
    for(const [metric,value] of Object.entries(processing))prefix+=alertNotificationCsvLine({row_type:'metadata',metric:`processing.${metric}`,value});
    suffix='';
  }
  const encoder=new TextEncoder(),head=new Uint8Array(encoder.encode(prefix)),tail=new Uint8Array(encoder.encode(suffix)),bytes=head.byteLength+tail.byteLength;
  if(bytes>ASYNC_EXPORT_ENVELOPE_RESERVE)throw new ServiceError('async_export_limit_exceeded',413);
  return {prefix:head,suffix:tail,bytes};
}
