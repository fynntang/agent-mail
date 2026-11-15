import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {ALERT_NOTIFICATION_DECISIONS,getAlertNotificationDecision,listAlertNotificationDecisions} from '../../src/lib/server/core/alert-notification-decisions';
import type {AlertNotificationDecisionReason} from '../../src/lib/types/alert-notification-decisions';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const file of (await readdir('migrations')).filter(value=>/^\d+.*\.sql$/.test(value)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${file}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',d1Databases:{DB:'notification-decisions'},r2Buckets:{MAIL_BLOBS:'notification-decisions'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(sql=>db.prepare(sql)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()-10_000;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Decisions',localPart:`decision-${crypto.randomUUID()}`});
async function record(mailboxId:string,reason:AlertNotificationDecisionReason='allowed',options:{time?:number;id?:string;outcome?:'failed'|'unknown'|'resolved';payload?:Record<string,unknown>;source?:string}={}){
  const eventId=options.id??crypto.randomUUID(),alertId=crypto.randomUUID(),time=options.time??at,outcome=options.outcome??'failed';
  const type=`cloudflare.suppression.alert.${outcome==='resolved'?'resolved':'created'}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(eventId,mailboxId,options.source??'app',eventId,type,JSON.stringify(options.payload??{alertId,kind:'sync',status:outcome==='resolved'?'resolved':'open',outcome,errorCode:'cloudflare_api_unavailable',extra:'PRIVATE_EVENT_PAYLOAD'}),time,time),
    env.DB.prepare('INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES(?,?,?,?,?,?,?)')
      .bind(eventId,mailboxId,alertId,reason,3,time,'PRIVATE_CLAIM_TOKEN')
  ]);return {eventId,alertId,time};
}
async function delivery(mailboxId:string,eventId:string,options:{state?:string;attempts?:number;error?:string;id?:string}={}){
  const endpointId=crypto.randomUUID(),id=options.id??crypto.randomUUID(),state=options.state??'pending';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at) VALUES(?,?,'https://PRIVATE.example.net/?token=PRIVATE','[]','{}',?,?)").bind(endpointId,mailboxId,at,at),
    env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,last_error_code,lease_token,lease_until)
      VALUES(?,?,?,?,?,?,?,1,'{"secret":"PRIVATE_CIPHERTEXT"}','https://PRIVATE.example.net/','{"PRIVATE":"RAW"}',?,?,?,?,?)`)
      .bind(id,mailboxId,endpointId,eventId,state,options.attempts??0,at,at,at,options.error??null,state==='running'?'lease':null,state==='running'?at+60_000:null)
  ]);return id;
}
const window=()=>({from:at-1000,to:at+1000});

it('returns an empty bounded window without Cloudflare configuration or any read-side writes',async()=>{
  const mailbox=await box();const database=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return(sql:string)=>{expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);return target.prepare(sql);};return Reflect.get(target,key,target);
  }});
  const result=await listAlertNotificationDecisions({...ctx,env:{...env,DB:database}},mailbox.id);
  expect(result.decisions).toEqual([]);expect(result.nextCursor).toBeNull();expect(result.summary).toEqual({total:0,allowed:0,skipped:0,
    byDecision:{allowed:0,disabled:0,quiet_hours:0,repeat_limited:0,recovery_disabled:0,no_subscribers:0},
    delivery:{total:0,pending:0,running:0,succeeded:0,dead:0,cancelled:0,attempts:0,quietDeferred:0}});
  expect(result.window.to-result.window.from).toBe(7*86_400_000);expect(await env.DB.prepare('SELECT COUNT(*) n FROM audit_events').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM alert_notification_policies').first('n')).toBe(0);
});

it('counts immutable mailbox decisions once and separates current endpoint deliveries and attempts',async()=>{
  const mailbox=await box(),records:Awaited<ReturnType<typeof record>>[]=[];for(const reason of ALERT_NOTIFICATION_DECISIONS)records.push(await record(mailbox.id,reason));
  await delivery(mailbox.id,records[0].eventId,{state:'succeeded',attempts:2});await delivery(mailbox.id,records[0].eventId,{attempts:1,error:'alert_quiet_hours'});
  const list=await listAlertNotificationDecisions(ctx,mailbox.id,window());
  expect(list.summary).toEqual({total:6,allowed:1,skipped:5,byDecision:{allowed:1,disabled:1,quiet_hours:1,repeat_limited:1,recovery_disabled:1,no_subscribers:1},
    delivery:{total:2,pending:1,running:0,succeeded:1,dead:0,cancelled:0,attempts:3,quietDeferred:1}});
  const item=list.decisions.find(value=>value.eventId===records[0].eventId)!;expect(item.delivery).toEqual(list.summary.delivery);
  expect(item).toMatchObject({eventType:'created',kind:'sync',outcome:'failed',errorCode:'cloudflare_api_unavailable',policyVersion:3,eventAvailable:true});
  const detail=await getAlertNotificationDecision(ctx,mailbox.id,item.eventId);expect(detail.deliveries).toHaveLength(2);expect(detail.deliveriesTruncated).toBe(false);
  expect(detail.deliveries.map(value=>value.lastErrorCode).sort()).toEqual(['alert_quiet_hours',null].sort());
  expect(JSON.stringify({list,detail})).not.toMatch(/PRIVATE|claim_token|payload_json|url_snapshot|signing_secret/);
});

it('applies exact half-open decision-time and reason/type filters to both rows and aggregate totals',async()=>{
  const mailbox=await box(),first=await record(mailbox.id,'quiet_hours',{time:at}),second=await record(mailbox.id,'quiet_hours',{time:at+1,outcome:'resolved'});
  await record(mailbox.id,'disabled',{time:at+2});await record(mailbox.id,'quiet_hours',{time:at+3});
  await delivery(mailbox.id,second.eventId,{state:'cancelled',attempts:1});
  const all=await listAlertNotificationDecisions(ctx,mailbox.id,{from:at,to:at+3});expect(all.summary.total).toBe(3);expect(all.decisions.some(value=>value.eventId===first.eventId)).toBe(true);
  const filtered=await listAlertNotificationDecisions(ctx,mailbox.id,{from:at,to:at+3,decision:'quiet_hours',eventType:'resolved'});
  expect(filtered.decisions.map(value=>value.eventId)).toEqual([second.eventId]);expect(filtered.summary).toMatchObject({total:1,allowed:0,skipped:1,byDecision:{quiet_hours:1,disabled:0},delivery:{total:1,cancelled:1}});
  expect(filtered.decisions[0]).toMatchObject({eventType:'resolved',outcome:'resolved',errorCode:null});
});

it('freezes inserted decision membership across equal-time pages even when later records are backdated',async()=>{
  const mailbox=await box(),initial:Awaited<ReturnType<typeof record>>[]=[];
  for(let i=0;i<5;i++)initial.push(await record(mailbox.id,'allowed',{id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}));
  const first=await listAlertNotificationDecisions(ctx,mailbox.id,{...window(),limit:2});expect(first.summary.total).toBe(5);
  await record(mailbox.id,'quiet_hours',{time:at-1});await record(mailbox.id,'quiet_hours',{time:at+1});
  const seen=first.decisions.map(value=>value.eventId);let cursor=first.nextCursor;
  while(cursor){const page=await listAlertNotificationDecisions(ctx,mailbox.id,{limit:2,cursor});expect(page.window).toEqual(first.window);expect(page.summary.total).toBe(5);seen.push(...page.decisions.map(value=>value.eventId));cursor=page.nextCursor;}
  expect(new Set(seen).size).toBe(5);expect(seen).toEqual(initial.map(value=>value.eventId).reverse());
  expect((await listAlertNotificationDecisions(ctx,mailbox.id,window())).summary.total).toBe(7);
});

it('keeps per-row and aggregate delivery counters consistent when a concurrent acknowledgement lands near the read boundary',async()=>{
  const mailbox=await box(),entry=await record(mailbox.id),id=await delivery(mailbox.id,entry.eventId,{attempts:1});
  let changed=false;const database=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return(sql:string)=>{const statement=target.prepare(sql);return new Proxy(statement,{get(prepared,method){
      if(method==='bind')return(...args:(string|number|null)[])=>new Proxy(prepared.bind(...args),{get(bound,operation){
        if(operation==='all'&&sql.includes('FROM webhook_deliveries'))return async()=>{const result=await bound.all();if(!changed){changed=true;await env.DB.prepare("UPDATE webhook_deliveries SET state='succeeded' WHERE id=?").bind(id).run();}return result;};
        return Reflect.get(bound,operation,bound);
      }});return Reflect.get(prepared,method,prepared);
    }});};return Reflect.get(target,key,target);
  }});
  const list=await listAlertNotificationDecisions({...ctx,env:{...env,DB:database}},mailbox.id,window());
  expect(list.decisions[0].delivery).toEqual(list.summary.delivery);expect(list.summary.delivery.total).toBe(1);
  await env.DB.prepare("UPDATE webhook_deliveries SET state='succeeded' WHERE id=?").bind(id).run();
  const detail=await getAlertNotificationDecision(ctx,mailbox.id,entry.eventId);expect(detail.decision.delivery.succeeded).toBe(1);expect(detail.deliveries[0].state).toBe('succeeded');
});

it('requires Owner context and exact mailbox scope while allowing paused reads and rejecting deleting mailboxes',async()=>{
  const first=await box(),second=await box(),entry=await record(first.id);
  await expect(listAlertNotificationDecisions({...ctx,actor:null},first.id)).rejects.toMatchObject({status:401});
  await expect(listAlertNotificationDecisions({...ctx,actor:{kind:'token',mailboxId:first.id,tokenId:crypto.randomUUID(),canRead:true}},first.id)).rejects.toMatchObject({status:403});
  expect((await listAlertNotificationDecisions(ctx,second.id,window())).summary.total).toBe(0);
  await expect(getAlertNotificationDecision(ctx,second.id,entry.eventId)).rejects.toMatchObject({status:404});
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(first.id).run();expect((await getAlertNotificationDecision(ctx,first.id,entry.eventId)).decision.eventId).toBe(entry.eventId);
  await env.DB.prepare("UPDATE mailboxes SET status='deleting' WHERE id=?").bind(first.id).run();await expect(listAlertNotificationDecisions(ctx,first.id)).rejects.toMatchObject({status:404});
});

it('retains malformed-source decisions honestly while dropping unsafe payload and transport diagnostics',async()=>{
  const mailbox=await box(),corrupt=await record(mailbox.id,'allowed',{payload:{alertId:'PRIVATE_BAD_ID',kind:'PRIVATE_KIND',outcome:'PRIVATE',errorCode:'PRIVATE'}}),external=await record(mailbox.id,'quiet_hours',{source:'external_provider'});
  await delivery(mailbox.id,corrupt.eventId,{error:'PRIVATE_UPSTREAM_ERROR'});
  const list=await listAlertNotificationDecisions(ctx,mailbox.id,window());expect(list.summary.total).toBe(2);expect(list.decisions).toHaveLength(2);
  for(const item of list.decisions)expect(item).toMatchObject({eventAvailable:false,eventType:null,kind:null,outcome:null,errorCode:null,occurredAt:null});
  const detail=await getAlertNotificationDecision(ctx,mailbox.id,corrupt.eventId);expect(detail.deliveries[0].lastErrorCode).toBeNull();expect(detail.deliveries[0].eventType).toBe('unknown');
  expect(JSON.stringify({list,detail})).not.toContain('PRIVATE');expect((await getAlertNotificationDecision(ctx,mailbox.id,external.eventId)).decision.decision).toBe('quiet_hours');
});

it('rejects invalid windows and cross-filter cursors, and bounds detail delivery rows without understating totals',async()=>{
  const first=await box(),second=await box(),entry=await record(first.id);await record(first.id);
  const list=await listAlertNotificationDecisions(ctx,first.id,{...window(),limit:1});expect(list.nextCursor).toBeTruthy();
  for(const query of [{decision:'unknown'},{eventType:'message.received'},{limit:0},{limit:101},{from:at,to:at},{from:0,to:32*86_400_000},{to:Date.now()+120_000},{extra:true}])
    await expect(listAlertNotificationDecisions(ctx,first.id,query)).rejects.toMatchObject({status:400});
  for(const query of [{limit:2},{decision:'allowed',limit:1},{eventType:'created',limit:1},{from:at-1,to:at+1,limit:1}])
    await expect(listAlertNotificationDecisions(ctx,first.id,{...query,cursor:list.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(listAlertNotificationDecisions(ctx,second.id,{limit:1,cursor:list.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  const bad=JSON.parse(atob(list.nextCursor!.replaceAll('-','+').replaceAll('_','/')));delete bad.from;bad.extra=1;
  await expect(listAlertNotificationDecisions(ctx,first.id,{limit:1,cursor:btoa(JSON.stringify(bad)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')})).rejects.toMatchObject({code:'invalid_cursor'});
  for(let i=0;i<101;i++)await delivery(first.id,entry.eventId);
  const detail=await getAlertNotificationDecision(ctx,first.id,entry.eventId);expect(detail.decision.delivery.total).toBe(101);expect(detail.deliveries).toHaveLength(100);expect(detail.deliveriesTruncated).toBe(true);
});
