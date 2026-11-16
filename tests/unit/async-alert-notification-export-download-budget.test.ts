import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {AsyncAlertNotificationExport,AsyncAlertNotificationExportState} from '../../src/lib/types/async-alert-notification-exports';
import type {OwnerContext} from '../../src/lib/server/core/owner';
import type {RuntimeEnv} from '../../src/lib/server/core/types';
import {sha256} from '../../src/lib/server/core/crypto';

const mock=vi.hoisted(()=>({getJob:vi.fn()}));
vi.mock('../../src/lib/server/core/async-alert-notification-exports',()=>({getAsyncAlertNotificationExport:mock.getJob}));
import {downloadAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-export-download';

class SizedStream extends TransformStream<Uint8Array,Uint8Array>{
  constructor(expected:number){let emitted=0;super({transform(chunk,controller){emitted+=chunk.byteLength;if(emitted>expected)throw Error('overflow');controller.enqueue(chunk);},flush(){if(emitted!==expected)throw Error('underflow');}});}
}
beforeEach(()=>{mock.getJob.mockReset();vi.stubGlobal('FixedLengthStream',SizedStream);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function fixture(count:number){
  let clock=Date.parse('2026-11-15T00:00:00.000Z'),live=true,calls=0,gets=0;
  vi.spyOn(Date,'now').mockImplementation(()=>clock);
  const box=crypto.randomUUID(),id=crypto.randomUUID(),bytes=new TextEncoder().encode('"decision","safe"\r\n'),digest=await sha256(bytes),prefix=`exports/alert-notification/${box}/${id}/`;
  const zero={total:0,pending:0,running:0,succeeded:0,dead:0,cancelled:0,attempts:0,quietDeferred:0};
  const job:AsyncAlertNotificationExport={id,mailboxId:box,format:'csv',state:'succeeded' as AsyncAlertNotificationExportState,version:3,window:{from:clock-1000,to:clock},
    filters:{decision:'all',eventType:'all'},snapshot:{decisionWatermark:count},totalDecisions:count,processedDecisions:count,processedDeliveries:0,chunkCount:count,bodyBytes:count*bytes.byteLength,
    summary:{total:count,allowed:count,skipped:0,byDecision:{allowed:count,disabled:0,quiet_hours:0,repeat_limited:0,recovery_disabled:0,no_subscribers:0},delivery:zero},
    createdAt:clock-100,updatedAt:clock,startedAt:clock-50,completedAt:clock,expiresAt:clock+3_600_000,observedFrom:clock-50,observedTo:clock,errorCode:null,canCancel:false,downloadAvailable:true};
  const chunks=Array.from({length:count},(_,index)=>({job_id:id,mailbox_id:box,sequence:index+1,object_key:`${prefix}lease/${index+1}.part`,size_bytes:bytes.byteLength,sha256:digest,created_at:clock}));
  interface Query{sql:string;args:unknown[];bind(...args:unknown[]):Query;first(column?:string):Promise<unknown>;all():Promise<unknown>}
  function rows(query:Query):unknown[]{
    if(query.sql.includes('SELECT 1 live'))return live?[{live:1}]:[];
    if(query.sql.includes('COUNT(*) count'))return [{count,bytes:job.bodyBytes,first:count?1:null,last:count||null}];
    if(query.sql.includes('SELECT job_id,mailbox_id,sequence'))return chunks.filter(chunk=>chunk.sequence>=Number(query.args[2])).slice(0,16);
    throw Error(`Unexpected query: ${query.sql}`);
  }
  const database={prepare(sql:string):Query{const query:Query={sql,args:[],bind(...args){query.args=args;return query;},async first(column){calls++;const value=rows(query)[0] as Record<string,unknown>|undefined;return column?value?.[column]:value??null;},async all(){calls++;return {results:rows(query),success:true,meta:{changes:0}};}};return query;},
    async batch(statements:Query[]){calls++;return statements.map(query=>({results:rows(query),success:true,meta:{changes:0}}));}} as unknown as D1Database;
  let onGet:(()=>void)|undefined;
  const bucket={async get(key:string){gets++;expect(key.startsWith(prefix)).toBe(true);onGet?.();return {body:new Response(bytes).body};}} as unknown as R2Bucket;
  const ctx:OwnerContext={env:{DB:database,MAIL_BLOBS:bucket} as RuntimeEnv,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
  mock.getJob.mockResolvedValue({job});
  return {ctx,box,id,job,bytes,calls:()=>calls,gets:()=>gets,setClock:(value:number)=>{clock=value;},setLive:(value:boolean)=>{live=value;},onGet:(callback:()=>void)=>{onGet=callback;}};
}

it('streams 2000 fragments within the Paid D1 invocation budget while verifying each R2 fragment',async()=>{
  const source=await fixture(2000),response=await downloadAsyncAlertNotificationExport(source.ctx,source.box,source.id),actual=new Uint8Array(await response.arrayBuffer());
  expect(actual.byteLength).toBe(Number(response.headers.get('content-length')));expect(source.gets()).toBe(2000);
  // One aggregate read and125 authorization/manifest batches. Real Owner lookup adds only fixed overhead.
  expect(source.calls()).toBeLessThanOrEqual(130);expect(source.calls()).toBeLessThan(1000);expect(mock.getJob).toHaveBeenCalledTimes(1);
},15_000);

it('rejects expiry both before starting a download and after an R2 read without waiting for the next manifest page',async()=>{
  const source=await fixture(32);source.setClock(source.job.expiresAt);
  await expect(downloadAsyncAlertNotificationExport(source.ctx,source.box,source.id)).rejects.toMatchObject({code:'async_export_expired',status:410});expect(source.gets()).toBe(0);
  source.setClock(source.job.createdAt+100);source.onGet(()=>source.setClock(source.job.expiresAt));vi.spyOn(console,'error').mockImplementation(()=>{});
  const response=await downloadAsyncAlertNotificationExport(source.ctx,source.box,source.id);
  await expect(response.arrayBuffer()).rejects.toThrow('async_export_download_unavailable');expect(source.gets()).toBe(1);
});

it('stops a retired mailbox at the next bounded manifest boundary and refuses retirement before the first fragment',async()=>{
  const source=await fixture(32);source.onGet(()=>{if(source.gets()===16)source.setLive(false);});vi.spyOn(console,'error').mockImplementation(()=>{});
  const response=await downloadAsyncAlertNotificationExport(source.ctx,source.box,source.id);await expect(response.arrayBuffer()).rejects.toThrow('async_export_download_unavailable');expect(source.gets()).toBe(16);
  const retired=await fixture(16);retired.setLive(false);const blocked=await downloadAsyncAlertNotificationExport(retired.ctx,retired.box,retired.id);
  await expect(blocked.arrayBuffer()).rejects.toThrow('async_export_download_unavailable');expect(retired.gets()).toBe(0);
});
