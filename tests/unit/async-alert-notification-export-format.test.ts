import {expect,it} from 'vitest';
import type {AlertNotificationExport} from '../../src/lib/types/alert-notification-export';
import {defaultAsyncAlertNotificationExportSummary} from '../../src/lib/server/core/async-alert-notification-exports';
import {formatAsyncExportChunk,formatAsyncExportEnvelope,ASYNC_EXPORT_CHUNK_MAX_BYTES,type AsyncExportEnvelopeSource} from '../../src/lib/server/core/async-alert-notification-export-format';

function fixture(){
  const at=Date.parse('2026-11-15T00:00:00Z'),summary=defaultAsyncAlertNotificationExportSummary();summary.total=2;summary.allowed=2;summary.byDecision.allowed=2;
  const job:AsyncExportEnvelopeSource={mailboxId:crypto.randomUUID(),format:'json',createdAt:at,startedAt:at+1,completedAt:at+2,observedFrom:at+1,observedTo:at+2,
    window:{from:at-86_400_000,to:at},filters:{decision:'all',eventType:'all'},snapshot:{decisionWatermark:2},summary};
  const items:AlertNotificationExport['decisions']=Array.from({length:2},()=>({eventId:crypto.randomUUID(),alertId:crypto.randomUUID(),decision:'allowed',policyVersion:0,decidedAt:at-1,
    eventAvailable:true,eventType:'created',kind:'sync',outcome:'failed',errorCode:'cloudflare_api_unavailable',occurredAt:at-2,delivery:{...summary.delivery},deliveries:[]}));return {job,items};
}
function join(parts:Uint8Array[]):string{const length=parts.reduce((n,part)=>n+part.byteLength,0),output=new Uint8Array(length);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.byteLength;}return new TextDecoder('utf-8',{ignoreBOM:true}).decode(output);}
it('joins independent JSON checkpoints into one valid document with matching summary and explicit per-batch observations',()=>{
  const {job,items}=fixture(),envelope=formatAsyncExportEnvelope(job),first=formatAsyncExportChunk(items.slice(0,1),'json',false),second=formatAsyncExportChunk(items.slice(1),'json',true);
  const file=JSON.parse(join([envelope.prefix,first,second,envelope.suffix]));expect(file.decisions).toEqual(items);expect(file.summary.total).toBe(2);
  expect(file.processing).toEqual({startedAt:job.startedAt,completedAt:job.completedAt,observedFrom:job.observedFrom,observedTo:job.observedTo,deliverySnapshot:'per_batch'});
  const empty={...job,summary:defaultAsyncAlertNotificationExportSummary()},zero=formatAsyncExportEnvelope(empty);
  expect(JSON.parse(join([zero.prefix,formatAsyncExportChunk([],'json',false),zero.suffix])).decisions).toEqual([]);
});
it('writes CSV header/BOM and summary once, with separate formula-safe checkpoint rows',()=>{
  const {job,items}=fixture();job.format='csv';items[0].alertId=' =1+1';const envelope=formatAsyncExportEnvelope(job),file=join([envelope.prefix,
    formatAsyncExportChunk(items.slice(0,1),'csv',false),formatAsyncExportChunk(items.slice(1),'csv',true),envelope.suffix]);
  expect(file.charCodeAt(0)).toBe(0xfeff);expect(file.split('"row_type"').length-1).toBe(1);expect(file.match(/^"decision",/gm)).toHaveLength(2);
  expect(file).toContain('"\' =1+1"');expect(file.match(/"summary","total","2"/g)).toHaveLength(1);expect(file.endsWith('\r\n')).toBe(true);
});
it('enforces bounded fragment size without imposing the synchronous eight MiB limit on the whole file',()=>{
  const {items}=fixture();items[0].alertId='x'.repeat(ASYNC_EXPORT_CHUNK_MAX_BYTES);
  expect(()=>formatAsyncExportChunk(items,'json',false)).toThrowError('async_export_batch_too_large');
  expect(()=>formatAsyncExportChunk(items,'csv',false)).toThrowError('async_export_batch_too_large');
  items[0].alertId='x'.repeat(1024*1024);const fragment=formatAsyncExportChunk(items.slice(0,1),'json',false);
  expect(fragment.byteLength*9).toBeGreaterThan(8*1024*1024);expect(fragment.byteLength).toBeLessThan(ASYNC_EXPORT_CHUNK_MAX_BYTES);
});
