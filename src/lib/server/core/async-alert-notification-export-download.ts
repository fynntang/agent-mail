import {getAsyncAlertNotificationExport,type AsyncAlertNotificationExportChunkRow} from './async-alert-notification-exports';
import {ASYNC_EXPORT_CHUNK_MAX_BYTES,ASYNC_EXPORT_MAX_BYTES,formatAsyncExportEnvelope} from './async-alert-notification-export-format';
import {sha256} from './crypto';
import type {OwnerContext} from './owner';
import {readBounded} from './storage';
import {ServiceError} from './types';

/** Private chunks are never exposed as URLs; every download starts with live Owner/mailbox authorization. */
export async function downloadAsyncAlertNotificationExport(ctx:OwnerContext,box:string,id:string,head=false):Promise<Response>{
  const {job}=await getAsyncAlertNotificationExport(ctx,box,id);
  if(job.expiresAt<=Date.now())throw new ServiceError('async_export_expired',410);
  if(job.state!=='succeeded')throw new ServiceError('async_export_not_ready',409);
  if(job.processedDecisions!==job.totalDecisions||job.summary.total!==job.processedDecisions||job.summary.delivery.total!==job.processedDeliveries
    ||job.summary.allowed+job.summary.skipped!==job.summary.total||job.summary.byDecision.allowed!==job.summary.allowed
    ||Object.values(job.summary.byDecision).reduce((total,count)=>total+count,0)!==job.summary.total
    ||(['pending','running','succeeded','dead','cancelled'] as const).reduce((total,key)=>total+job.summary.delivery[key],0)!==job.summary.delivery.total)
    throw new ServiceError('async_export_source_changed',409);
  const manifest=await ctx.env.DB.prepare(`SELECT COUNT(*) count,COALESCE(SUM(size_bytes),0) bytes,MIN(sequence) first,MAX(sequence) last
    FROM async_alert_notification_export_chunks WHERE mailbox_id=? AND job_id=?`).bind(box,id).first<{count:number;bytes:number;first:number|null;last:number|null}>();
  if(!manifest||manifest.count!==job.chunkCount||manifest.bytes!==job.bodyBytes||job.chunkCount>0&&(manifest.first!==1||manifest.last!==job.chunkCount))throw new ServiceError('async_export_missing_chunk',503);
  const envelope=formatAsyncExportEnvelope(job),length=envelope.bytes+job.bodyBytes;
  if(length>ASYNC_EXPORT_MAX_BYTES)throw new ServiceError('async_export_limit_exceeded',413);
  const headers={'Content-Type':job.format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8',
    'Content-Disposition':`attachment; filename="alert-notification-decisions-${box}-${id}.${job.format}"`,
    'Content-Length':String(length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  if(head)return new Response(null,{headers});
  const namespace=`exports/alert-notification/${box}/${id}/`;let phase:'prefix'|'body'|'suffix'|'done'='prefix',next=1,emitted=0,cancelled=false;
  let rows:AsyncAlertNotificationExportChunkRow[]=[];
  const ensureNotExpired=()=>{
    if(job.expiresAt<=Date.now())throw new ServiceError('async_export_expired',410);
  };
  const readManifestPage=async()=>{
    // One D1 call per 16 immutable fragments keeps even 100,000 decisions below
    // D1's per-invocation query limit. Recheck retirement between manifest pages.
    const page=await ctx.env.DB.batch([
      ctx.env.DB.prepare(`SELECT 1 live FROM async_alert_notification_exports j JOIN mailboxes m ON m.id=j.mailbox_id
        WHERE j.id=? AND j.mailbox_id=? AND j.state='succeeded' AND j.expires_at>? AND m.status IN('active','paused')`).bind(id,box,Date.now()),
      ctx.env.DB.prepare(`SELECT job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at
        FROM async_alert_notification_export_chunks WHERE job_id=? AND mailbox_id=? AND sequence>=? ORDER BY sequence LIMIT 16`).bind(id,box,next)
    ]);
    ensureNotExpired();if(!page[0].results.length)throw new ServiceError('async_export_not_ready',409);
    rows=page[1].results as unknown as AsyncAlertNotificationExportChunkRow[];
  };
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        if(cancelled)return;
        // TTL is local and checked on every pull and after every R2 read.
        ensureNotExpired();
        if(phase==='prefix'){phase='body';controller.enqueue(envelope.prefix);return;}
        if(phase==='body'&&next<=job.chunkCount){
          if(!rows.length)await readManifestPage();
          const chunk=rows.shift();
          if(!chunk||chunk.sequence!==next||!chunk.object_key.startsWith(namespace)||chunk.size_bytes<1||chunk.size_bytes>ASYNC_EXPORT_CHUNK_MAX_BYTES
            ||!/^[0-9a-f]{64}$/.test(chunk.sha256))throw new ServiceError('async_export_missing_chunk',503);
          const object=await ctx.env.MAIL_BLOBS.get(chunk.object_key);if(!object)throw new ServiceError('async_export_missing_chunk',503);
          const bytes=await readBounded(object.body,ASYNC_EXPORT_CHUNK_MAX_BYTES);
          if(bytes.byteLength!==chunk.size_bytes||await sha256(bytes)!==chunk.sha256)throw new ServiceError('async_export_checksum_mismatch',503);
          ensureNotExpired();
          if(cancelled)return;emitted+=bytes.byteLength;if(emitted>job.bodyBytes)throw new ServiceError('async_export_checksum_mismatch',503);
          next++;controller.enqueue(bytes);return;
        }
        if(phase==='body'){if(emitted!==job.bodyBytes)throw new ServiceError('async_export_missing_chunk',503);phase='suffix';}
        if(phase==='suffix'){phase='done';if(envelope.suffix.byteLength)controller.enqueue(envelope.suffix);controller.close();}
      }catch{if(!cancelled){console.error(JSON.stringify({event:'async_export_download_failed'}));controller.error(new Error('async_export_download_unavailable'));}}
    },cancel(){cancelled=true;rows=[];}
  });
  // Workers derives Content-Length from an intrinsically sized stream, not an arbitrary header.
  return new Response(body.pipeThrough(new FixedLengthStream(length)),{headers});
}
