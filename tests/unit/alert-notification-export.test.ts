import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {ALERT_NOTIFICATION_DECISIONS,listAlertNotificationDecisions} from '../../src/lib/server/core/alert-notification-decisions';
import {exportAlertNotificationDecisions,ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS,ALERT_NOTIFICATION_EXPORT_MAX_DELIVERIES} from '../../src/lib/server/core/alert-notification-export';
import type {AlertNotificationExportQuery} from '../../src/lib/types/alert-notification-export';
import type {AlertNotificationDecisionReason} from '../../src/lib/types/alert-notification-decisions';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const file of (await readdir('migrations')).filter(value=>/^\d+.*\.sql$/.test(value)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${file}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',d1Databases:{DB:'notification-export'},r2Buckets:{MAIL_BLOBS:'notification-export'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(sql=>db.prepare(sql)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()-10_000;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Exports',localPart:`export-${crypto.randomUUID()}`});
const window=()=>({from:at-1000,to:at+1000});
async function records(mailboxId:string,count:number,reason:AlertNotificationDecisionReason='allowed',options:{time?:number;resolved?:boolean;payload?:Record<string,unknown>;source?:string}={}){
  const ids=Array.from({length:count},()=>crypto.randomUUID()),alertId=crypto.randomUUID(),time=options.time??at,json=JSON.stringify(ids);
  const payload=JSON.stringify(options.payload??{alertId,kind:'sync',status:options.resolved?'resolved':'open',outcome:options.resolved?'resolved':'failed',errorCode:'cloudflare_api_unavailable',private:'PRIVATE_PAYLOAD'});
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
      SELECT value,?,?,value,?,?,?,? FROM json_each(?)`).bind(mailboxId,options.source??'app',`cloudflare.suppression.alert.${options.resolved?'resolved':'created'}`,payload,time,time,json),
    env.DB.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token)
      SELECT value,?,?,?,?,?,'PRIVATE_CLAIM_TOKEN' FROM json_each(?)`).bind(mailboxId,alertId,reason,3,time,json)
  ]);return {ids,alertId};
}
async function endpoint(mailboxId:string){
  const id=crypto.randomUUID();await env.DB.prepare(`INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at)
    VALUES(?,?,'https://PRIVATE.example.net/?token=PRIVATE','[]','{}',?,?)`).bind(id,mailboxId,at,at).run();return id;
}
async function delivery(mailboxId:string,eventId:string,state='pending',attempts=0,error:string|null=null,endpointId?:string){
  const id=crypto.randomUUID(),target=endpointId??await endpoint(mailboxId);
  await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,
    created_at,updated_at,last_error_code,lease_token,lease_until) VALUES(?,?,?,?,?,?,?,1,'{"PRIVATE":"CIPHER"}','https://PRIVATE.example.net/','{"PRIVATE":"RAW"}',?,?,?,?,?)`)
    .bind(id,mailboxId,target,eventId,state,attempts,at,at,at,error,state==='running'?'PRIVATE_LEASE':null,state==='running'?at+60_000:null).run();return id;
}

it('exports an empty default window with no writes or configuration dependency',async()=>{
  const mailbox=await box(),database=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return(sql:string)=>{expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);return target.prepare(sql);};return Reflect.get(target,key,target);
  }}),before=Date.now(),result=await exportAlertNotificationDecisions({...ctx,env:{...env,DB:database}},mailbox.id);
  expect(result).toMatchObject({version:1,mailboxId:mailbox.id,filters:{decision:'all',eventType:'all'},snapshot:{decisionWatermark:0},decisions:[],summary:{total:0,allowed:0,skipped:0,delivery:{total:0,attempts:0}}});
  expect(result.window.to-result.window.from).toBe(7*86_400_000);expect(result.generatedAt).toBeGreaterThanOrEqual(before);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM audit_events').first('n')).toBe(1);expect(await env.DB.prepare('SELECT COUNT(*) n FROM alert_notification_state').first('n')).toBe(0);
});

it('exports the complete selected dataset beyond a list page and separates event and endpoint counts',async()=>{
  const mailbox=await box(),first=await records(mailbox.id,1);for(const reason of ALERT_NOTIFICATION_DECISIONS.filter(reason=>reason!=='allowed'))await records(mailbox.id,1,reason);
  await records(mailbox.id,24,'quiet_hours');await delivery(mailbox.id,first.ids[0],'succeeded',2);await delivery(mailbox.id,first.ids[0],'pending',1,'alert_quiet_hours');
  const page=await listAlertNotificationDecisions(ctx,mailbox.id,window()),result=await exportAlertNotificationDecisions(ctx,mailbox.id,window());
  expect(page.decisions).toHaveLength(20);expect(result.decisions).toHaveLength(30);expect(result.summary).toEqual(page.summary);
  expect(result.summary).toMatchObject({total:30,allowed:1,skipped:29,byDecision:{quiet_hours:25,repeat_limited:1},delivery:{total:2,succeeded:1,pending:1,attempts:3,quietDeferred:1}});
  expect(result.decisions.find(item=>item.eventId===first.ids[0])?.deliveries).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|claim_token|payload_json|url_snapshot|signing_secret/);
});

it('applies the same half-open time, reason and notification-type filters as Owner history',async()=>{
  const mailbox=await box();await records(mailbox.id,1,'quiet_hours',{time:at-1});const start=await records(mailbox.id,1,'quiet_hours',{time:at,resolved:true});
  await records(mailbox.id,1,'quiet_hours',{time:at+1});await records(mailbox.id,1,'disabled',{time:at+2,resolved:true});await records(mailbox.id,1,'quiet_hours',{time:at+3,resolved:true});
  await delivery(mailbox.id,start.ids[0],'cancelled',1,'alert_recovery_disabled');
  const query={from:at,to:at+3,decision:'quiet_hours',eventType:'resolved'},result=await exportAlertNotificationDecisions(ctx,mailbox.id,query),list=await listAlertNotificationDecisions(ctx,mailbox.id,query);
  expect(result.decisions.map(item=>item.eventId)).toEqual([start.ids[0]]);expect(result.summary).toEqual(list.summary);
  expect(result.decisions[0]).toMatchObject({eventType:'resolved',outcome:'resolved',errorCode:null});expect(result.filters).toEqual({decision:'quiet_hours',eventType:'resolved'});
});

it('freezes decision membership before the single delivery snapshot and includes a concurrent acknowledgement consistently',async()=>{
  const mailbox=await box(),initial=await records(mailbox.id,1),id=await delivery(mailbox.id,initial.ids[0],'pending',1);let changed=false;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    if(!changed){changed=true;await records(mailbox.id,1,'quiet_hours',{time:at-1});await env.DB.prepare("UPDATE webhook_deliveries SET state='succeeded' WHERE id=?").bind(id).run();}
    return target.batch(statements);
  };return Reflect.get(target,key,target);}});
  const result=await exportAlertNotificationDecisions({...ctx,env:{...env,DB:database}},mailbox.id,window());
  expect(result.decisions.map(item=>item.eventId)).toEqual(initial.ids);expect(result.summary.total).toBe(1);expect(result.summary.delivery).toMatchObject({total:1,succeeded:1,pending:0});
  expect(result.decisions[0].delivery).toEqual(result.summary.delivery);expect(result.decisions[0].deliveries[0].state).toBe('succeeded');
  expect((await exportAlertNotificationDecisions(ctx,mailbox.id,window())).summary.total).toBe(2);
});

it('enforces Owner/mailbox permission and strict export queries while retaining safe corrupt-source decisions',async()=>{
  const mailbox=await box(),other=await box(),entry=await records(mailbox.id,1,'allowed',{payload:{alertId:'PRIVATE_BAD',kind:'PRIVATE',errorCode:'PRIVATE'}});await delivery(mailbox.id,entry.ids[0],'pending',0,'PRIVATE_PROVIDER_DIAGNOSTIC');
  await expect(exportAlertNotificationDecisions({...ctx,actor:null},mailbox.id)).rejects.toMatchObject({status:401});
  await expect(exportAlertNotificationDecisions({...ctx,actor:{kind:'token',mailboxId:mailbox.id,tokenId:crypto.randomUUID(),canRead:true}},mailbox.id)).rejects.toMatchObject({status:403});
  expect((await exportAlertNotificationDecisions(ctx,other.id)).summary.total).toBe(0);
  for(const query of [{limit:20},{cursor:'abc'},{decision:'unsupported'},{eventType:'message.received'},{from:at,to:at},{from:0,to:32*86_400_000},{to:Date.now()+120_000},{from:true}])
    await expect(exportAlertNotificationDecisions(ctx,mailbox.id,query as AlertNotificationExportQuery)).rejects.toMatchObject({status:400});
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();const result=await exportAlertNotificationDecisions(ctx,mailbox.id,window());
  expect(result.summary.total).toBe(1);expect(result.decisions[0]).toMatchObject({eventAvailable:false,eventType:null,outcome:null,errorCode:null});expect(result.decisions[0].deliveries[0]).toMatchObject({eventType:'unknown',lastErrorCode:null});expect(JSON.stringify(result)).not.toContain('PRIVATE');
  await env.DB.prepare("UPDATE mailboxes SET status='deleting' WHERE id=?").bind(mailbox.id).run();await expect(exportAlertNotificationDecisions(ctx,mailbox.id)).rejects.toMatchObject({status:404});
});

it('exports exactly the decision cap and rejects one additional matching record without returning a partial export',async()=>{
  const mailbox=await box();await records(mailbox.id,ALERT_NOTIFICATION_EXPORT_MAX_DECISIONS);
  const exact=await exportAlertNotificationDecisions(ctx,mailbox.id,window());expect(exact.decisions).toHaveLength(1000);expect(exact.summary.total).toBe(1000);
  await records(mailbox.id,1);await expect(exportAlertNotificationDecisions(ctx,mailbox.id,window())).rejects.toMatchObject({status:413,code:'alert_notification_export_too_large'});
  const narrow=await exportAlertNotificationDecisions(ctx,mailbox.id,{...window(),decision:'quiet_hours'});expect(narrow.decisions).toEqual([]);
});

it('exports exactly the delivery cap and rejects one more endpoint result instead of silently truncating',async()=>{
  const mailbox=await box(),initial=await records(mailbox.id,50),endpoints=Array.from({length:100},()=>crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at)
      SELECT value,?,'https://PRIVATE.example.net/','[]','{}',?,? FROM json_each(?)`).bind(mailbox.id,at,at,JSON.stringify(endpoints)),
    env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),?,w.value,e.value,'succeeded',1,?,1,'{}',?,? FROM json_each(?) w CROSS JOIN json_each(?) e`)
      .bind(mailbox.id,at,at,at,JSON.stringify(endpoints),JSON.stringify(initial.ids))
  ]);
  const exact=await exportAlertNotificationDecisions(ctx,mailbox.id,window());expect(exact.summary.delivery).toMatchObject({total:ALERT_NOTIFICATION_EXPORT_MAX_DELIVERIES,succeeded:5000,attempts:5000});expect(exact.decisions.flatMap(item=>item.deliveries)).toHaveLength(5000);
  const extra=await records(mailbox.id,1);await delivery(mailbox.id,extra.ids[0],'succeeded',1,null,endpoints[0]);
  await expect(exportAlertNotificationDecisions(ctx,mailbox.id,window())).rejects.toMatchObject({status:413,code:'alert_notification_export_too_large'});
},30_000);
