import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const path=box=>`/owner/api/mailboxes/${box.id}/alert-notification-exports`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Async export',localPart:`async-${randomUUID()}`}}),201)).mailbox;}
async function tick(runtime){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function seed(runtime,box,count,withDeliveries=false){
  const at=Date.now()-1000,entries=Array.from({length:count},(_,i)=>({id:randomUUID(),alert:randomUUID(),at:at-i}));
  for(let offset=0;offset<entries.length;offset+=1000){const part=entries.slice(offset,offset+1000);
    await runtime.db.batch([
      runtime.db.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at,webhook_published_at)
        SELECT json_extract(value,'$.id'),?,'app',json_extract(value,'$.id'),'cloudflare.suppression.alert.created',
          json_object('alertId',json_extract(value,'$.alert'),'kind','sync','status','open','outcome','failed','errorCode','cloudflare_api_unavailable'),
          json_extract(value,'$.at'),json_extract(value,'$.at'),? FROM json_each(?)`).bind(box.id,at,JSON.stringify(part)),
      runtime.db.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.alert'),'allowed',0,json_extract(value,'$.at'),'PRIVATE_ASYNC_CLAIM' FROM json_each(?)`).bind(box.id,JSON.stringify(part))
    ]);
  }
  if(withDeliveries){
    const endpoints=Array.from({length:10},()=>randomUUID());
    await runtime.db.prepare(`INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at)
      SELECT value,?,'https://hooks.example.net/PRIVATE_ASYNC_URL','[]','{}',?,? FROM json_each(?)`).bind(box.id,at-100,at-100,JSON.stringify(endpoints)).run();
    for(let offset=0;offset<entries.length;offset+=500){
      const rows=entries.slice(offset,offset+500).flatMap(item=>endpoints.map((endpoint,index)=>({id:randomUUID(),event:item.id,endpoint,state:index%2?'dead':'succeeded'})));
      await runtime.db.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,
        signing_secret_ciphertext,payload_json,url_snapshot,last_http_status,last_error_code,completed_at,created_at,updated_at)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.endpoint'),json_extract(value,'$.event'),json_extract(value,'$.state'),1,?,1,
          '{}','{}','https://hooks.example.net/PRIVATE_ASYNC_URL',CASE WHEN json_extract(value,'$.state')='succeeded' THEN 204 ELSE 400 END,
          CASE WHEN json_extract(value,'$.state')='dead' THEN 'http_rejected' ELSE NULL END,?,?,? FROM json_each(?)`).bind(box.id,at,at,at,at,JSON.stringify(rows)).run();
    }
  }
  return {entries,from:at-count-1,to:Date.now()+1};
}
async function create(runtime,box,format,range,requestId=randomUUID()){
  return (await json(await runtime.request(path(box),{method:'POST',body:{clientRequestId:requestId,format,from:range.from,to:range.to}}),202)).job;
}
async function finish(runtime,box,ids){
  for(let round=0;round<20;round++){
    const jobs=await Promise.all(ids.map(async id=>(await json(await runtime.request(`${path(box)}/${id}`))).job));
    if(jobs.every(job=>job.state==='succeeded'))return jobs;
    assert.ok(jobs.every(job=>['queued','running','succeeded'].includes(job.state)),JSON.stringify(jobs));await tick(runtime);
  }
  assert.fail('bounded scheduled passes did not finish test export');
}
function safe(value){const text=typeof value==='string'?value:JSON.stringify(value);for(const marker of ['PRIVATE_ASYNC','object_key','lease_token','request_hash','signing_secret_ciphertext','cleanup_due_at'])assert.equal(text.includes(marker),false,marker);}
function csvRows(raw){
  assert.equal(raw.charCodeAt(0),0xfeff);const rows=[];let cells=[],cell='',quoted=false;
  for(let i=1;i<raw.length;i++){const c=raw[i];if(c==='"'){if(quoted&&raw[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){cells.push(cell);cell='';}else if(c==='\r'&&raw[i+1]==='\n'&&!quoted){cells.push(cell);rows.push(cells);cells=[];cell='';i++;}else cell+=c;}
  assert.equal(quoted,false);assert.deepEqual(cells,[]);assert.equal(cell,'');const header=rows.shift();return rows.map(row=>Object.fromEntries(header.map((name,i)=>[name,row[i]])));
}

test('native scheduled builds large CSV and JSON beyond synchronous limits into private R2 fragments with exact totals',{timeout:120_000},async t=>{
  const external=[];const runtime=await createOwnerRuntime({outboundService:async request=>{external.push(request.url);return new Response(null,{status:500});}});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),range=await seed(runtime,box,2001,true),requestId=randomUUID();
  const csv=await create(runtime,box,'csv',range,requestId),replay=await create(runtime,box,'csv',range,requestId),doc=await create(runtime,box,'json',range);
  assert.equal(replay.id,csv.id);assert.equal(csv.totalDecisions,2001);safe(csv);
  await tick(runtime);const progress=(await json(await runtime.request(`${path(box)}/${csv.id}`))).job;
  assert.ok(progress.processedDecisions>0&&progress.processedDecisions<2001);assert.equal(progress.downloadAvailable,false);
  await seed(runtime,box,1);const complete=await finish(runtime,box,[csv.id,doc.id]);assert.ok(complete.every(job=>job.processedDecisions===2001&&job.processedDeliveries===20010));
  const response=await runtime.request(`${path(box)}/${doc.id}/download`,{headers:{'Accept-Encoding':'identity'}}),bytes=new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status,200);assert.ok(bytes.byteLength>8*1024*1024,'Large download is streamed beyond the synchronous 8 MiB cap');
  assert.equal(Number(response.headers.get('content-length')),bytes.byteLength,JSON.stringify([...response.headers]));assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const data=JSON.parse(new TextDecoder().decode(bytes));safe(data);assert.equal(data.decisions.length,2001);assert.equal(data.summary.total,2001);assert.equal(data.summary.delivery.total,20010);assert.equal(data.summary.delivery.succeeded,10005);assert.equal(data.processing.deliverySnapshot,'per_batch');
  assert.equal(data.decisions.reduce((sum,item)=>sum+item.deliveries.length,0),20010);assert.equal(new Set(data.decisions.map(item=>item.eventId)).size,2001);
  const csvResponse=await runtime.request(`${path(box)}/${csv.id}/download`),csvBytes=new Uint8Array(await csvResponse.arrayBuffer()),rows=csvRows(new TextDecoder('utf-8',{ignoreBOM:true}).decode(csvBytes));
  assert.equal(csvResponse.status,200);assert.equal(rows.filter(row=>row.row_type==='decision').length,2001);assert.equal(rows.filter(row=>row.row_type==='delivery').length,20010);assert.equal(rows.find(row=>row.row_type==='summary'&&row.metric==='delivery.total').value,'20010');safe(rows);
  const head=await runtime.request(`${path(box)}/${doc.id}/download`,{method:'HEAD',headers:{'Accept-Encoding':'identity'}});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(Number(head.headers.get('content-length')),bytes.byteLength);
  const page=await json(await runtime.request(`${path(box)}?limit=1`));assert.equal(page.jobs.length,1);assert.ok(page.nextCursor);assert.equal((await json(await runtime.request(`${path(box)}?limit=1&cursor=${page.nextCursor}`))).jobs.length,1);
  assert.deepEqual(external,[]);assert.ok((await runtime.bucket.list({prefix:`exports/alert-notification/${box.id}/${doc.id}/`})).objects.length>1);
});

test('Owner cancels partial work, cleanup deletes its prefix and later orphan writes without touching other private objects',{timeout:60_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),range=await seed(runtime,box,1001),job=await create(runtime,box,'json',range);
  await tick(runtime);const current=(await json(await runtime.request(`${path(box)}/${job.id}`))).job;assert.ok(current.processedDecisions>0&&current.processedDecisions<1001);
  await json(await runtime.request(`${path(box)}/${job.id}/cancel`,{method:'POST',body:{expectedVersion:job.version}}),409);
  const cancelled=(await json(await runtime.request(`${path(box)}/${job.id}/cancel`,{method:'POST',body:{expectedVersion:current.version}}))).job;assert.equal(cancelled.state,'cancelled');safe(cancelled);
  await json(await runtime.request(`${path(box)}/${job.id}/download`),409);const prefix=`exports/alert-notification/${box.id}/${job.id}/`;
  await runtime.bucket.put('unrelated-private-object','KEEP');await tick(runtime);assert.deepEqual((await runtime.bucket.list({prefix})).objects,[]);
  await runtime.bucket.put(`${prefix}late-worker/extra.part`,'late');
  await runtime.db.prepare('UPDATE async_alert_notification_exports SET cleanup_due_at=0,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(job.id).run();
  await tick(runtime);assert.deepEqual((await runtime.bucket.list({prefix})).objects,[]);assert.equal(await (await runtime.bucket.get('unrelated-private-object')).text(),'KEEP');
  assert.ok(await runtime.db.prepare('SELECT count(*) n FROM async_alert_notification_export_chunks WHERE job_id=?').bind(job.id).first('n'));assert.equal((await json(await runtime.request(`${path(box)}/${job.id}`))).job.state,'cancelled');
});

test('async tasks require live Owner scope and Origin, preserve idempotency and reject cross-mailbox metadata or downloads',{timeout:60_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),other=await mailbox(runtime),range=await seed(runtime,box,1),id=randomUUID();
  const job=await create(runtime,box,'json',range,id);assert.equal((await runtime.request(path(box),{authenticated:false})).status,401);
  const secret=(await json(await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'Denied export',scopes:['mail:read']}}),201)).secret;
  assert.equal((await runtime.mf.dispatchFetch(`https://console.example.com${path(box)}`,{headers:{Authorization:`Bearer ${secret}`}})).status,401);
  assert.equal((await runtime.mf.dispatchFetch(`https://console.example.com${path(box)}`,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,'Content-Type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID(),format:'json'})})).status,403);
  await json(await runtime.request(`${path(other)}/${job.id}`),404);await json(await runtime.request(`${path(other)}/${job.id}/download`),404);
  await json(await runtime.request(path(box),{method:'POST',body:{clientRequestId:id,format:'csv',from:range.from,to:range.to}}),409);
  await json(await runtime.request(`${path(box)}?limit=1&limit=2`),400);await json(await runtime.request(`${path(box)}/${job.id}?extra=1`),400);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();await finish(runtime,box,[job.id]);
  const before=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n');safe(await json(await runtime.request(`${path(box)}/${job.id}`)));
  assert.equal((await runtime.request(`${path(box)}/${job.id}/download`)).status,200);assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),before);
});

test('expiry revokes access before deletion, and missing or corrupted private chunks never produce a successful complete file',{timeout:60_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),range=await seed(runtime,box,1),job=await create(runtime,box,'json',range);
  await finish(runtime,box,[job.id]);const chunk=await runtime.db.prepare('SELECT * FROM async_alert_notification_export_chunks WHERE job_id=?').bind(job.id).first();
  await runtime.bucket.put(chunk.object_key,'CORRUPTED');await assert.rejects(async()=>{const damaged=await runtime.request(`${path(box)}/${job.id}/download`);await damaged.arrayBuffer();});
  const expiredId=randomUUID(),now=Date.now(),old=now-90_000_000;
  await runtime.db.prepare(`INSERT INTO async_alert_notification_exports(id,mailbox_id,client_request_id,request_hash,format,filter_decision,filter_event_type,from_ms,to_ms,
    decision_watermark,total_decisions,processed_decisions,processed_deliveries,chunk_count,body_bytes,summary_json,state,created_at,updated_at,completed_at,expires_at,available_at,cleanup_due_at)
    SELECT ?,mailbox_id,?,request_hash,format,filter_decision,filter_event_type,from_ms,to_ms,decision_watermark,total_decisions,processed_decisions,processed_deliveries,
      chunk_count,body_bytes,summary_json,'succeeded',?,?,?, ?,?,? FROM async_alert_notification_exports WHERE id=?`).bind(expiredId,randomUUID(),old,old,old+1000,now-1,old,now-1,job.id).run();
  const key=`exports/alert-notification/${box.id}/${expiredId}/old/1.part`,body=new TextEncoder().encode('expired');await runtime.bucket.put(key,body);
  await runtime.db.prepare('INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at) VALUES(?,?,1,?,?,?,?)')
    .bind(expiredId,box.id,key,body.byteLength,createHash('sha256').update(body).digest('hex'),old).run();
  assert.equal((await json(await runtime.request(`${path(box)}/${expiredId}`))).job.state,'expired');await json(await runtime.request(`${path(box)}/${expiredId}/download`),410);
  assert.ok(await runtime.bucket.head(key));await tick(runtime);assert.equal(await runtime.bucket.head(key),null);assert.equal((await runtime.db.prepare('SELECT state FROM async_alert_notification_exports WHERE id=?').bind(expiredId).first()).state,'expired');
});
