import type {CloudflareSuppressionAlert,CloudflareSuppressionAlertDetail,CloudflareSuppressionAlertList,CloudflareSuppressionAlertOutcome} from '../../types/cloudflare-suppression-alerts';
import {cloudflareSuppressionIdentity} from './cloudflare-suppression-config';
import {sha256,stableId} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';

export const SUPPRESSION_ALERT_ERROR_CODES=['operation_lease_expired','cloudflare_api_unavailable','cloudflare_api_timeout','cloudflare_api_invalid_response',
  'cloudflare_api_scope_mismatch','cloudflare_api_rejected','cloudflare_delete_unknown','cloudflare_suppression_sync_limit','cloudflare_suppression_sync_expired',
  'cloudflare_suppression_busy','cloudflare_suppression_changed','cloudflare_suppression_read_only','cloudflare_operation_pending'] as const;
export function safeAlertErrorCode(value:unknown):string|null{return typeof value==='string'&&(SUPPRESSION_ALERT_ERROR_CODES as readonly string[]).includes(value)?value:null;}
type Config=NonNullable<ReturnType<typeof cloudflareSuppressionIdentity>>;
interface Journal {journal_rowid:number;id:string;kind:'sync'|'release';resource_id:string;action:string;state:string;remote_status:string|null;error_code:string|null;occurred_at:number}
interface AlertRow {id:string;kind:'sync'|'release';status:CloudflareSuppressionAlert['status'];outcome:CloudflareSuppressionAlertOutcome;version:number;generation:number;occurrences:number;
  error_code:string|null;first_occurred_at:number;last_occurred_at:number;acknowledged_at:number|null;resolved_at:number|null;source_id:string;global_scope:number;source_mailbox_id:string|null}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sql=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
function dto(row:AlertRow):CloudflareSuppressionAlert{return {id:row.id,kind:row.kind,status:row.status,outcome:row.outcome,version:row.version,generation:row.generation,occurrences:row.occurrences,
  errorCode:safeAlertErrorCode(row.error_code),firstOccurredAt:row.first_occurred_at,lastOccurredAt:row.last_occurred_at,acknowledgedAt:row.acknowledged_at,resolvedAt:row.resolved_at,source:{kind:row.kind,sourceId:row.source_id,...(row.source_mailbox_id?{mailboxId:row.source_mailbox_id}:{})},global:row.global_scope===1};}
async function authorize(ctx:OwnerContext,box:string):Promise<Config|null>{
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
  const config=cloudflareSuppressionIdentity(ctx.env);if(config&&mailbox.address.split('@')[1]!==config.domain)throw new ServiceError('cloudflare_suppression_domain_mismatch',409);return config;
}
/** UNION deduplicates corrupt lineage cycles rather than looping; only the configured account/domain participates. */
async function lineage(env:RuntimeEnv,config:Config,row:Journal):Promise<{key:string;box:string|null;global:boolean}|null>{
  if(row.kind==='sync'){
    const root=await sql(env,`WITH RECURSIVE chain AS(SELECT id,retry_of,source,mailbox_id FROM cloudflare_suppression_sync_runs WHERE id=? AND account_id=? AND domain=?
      UNION SELECT p.id,p.retry_of,p.source,p.mailbox_id FROM cloudflare_suppression_sync_runs p JOIN chain c ON p.id=c.retry_of WHERE p.account_id=? AND p.domain=?)
      SELECT * FROM chain WHERE retry_of IS NULL LIMIT 1`,row.resource_id,config.accountId,config.domain,config.accountId,config.domain).first<{id:string;source:string;mailbox_id:string|null}>();
    return root?(root.source==='scheduled'?{key:'scheduled',box:null,global:true}:root.mailbox_id?{key:root.id,box:root.mailbox_id,global:false}:null):null;
  }
  const root=await sql(env,`WITH RECURSIVE chain AS(SELECT id,retry_of,mailbox_id FROM cloudflare_suppression_operations WHERE id=? AND account_id=? AND domain=?
    UNION SELECT p.id,p.retry_of,p.mailbox_id FROM cloudflare_suppression_operations p JOIN chain c ON p.id=c.retry_of WHERE p.account_id=? AND p.domain=?)
    SELECT * FROM chain WHERE retry_of IS NULL LIMIT 1`,row.resource_id,config.accountId,config.domain,config.accountId,config.domain).first<{id:string;mailbox_id:string}>();
  return root?{key:root.id,box:root.mailbox_id,global:false}:null;
}
function transition(row:Journal):{action:'failed'|'resolved';outcome:CloudflareSuppressionAlertOutcome;error:string|null}|null{
  if(row.action==='legacy.snapshot'||row.action.endsWith('.started'))return null;
  if(row.kind==='sync'){
    if(row.action!=='sync.completed')return null;
    if(row.state==='succeeded')return {action:'resolved',outcome:'resolved',error:null};
    if(row.state==='failed')return {action:'failed',outcome:'failed',error:safeAlertErrorCode(row.error_code)??'cloudflare_api_unavailable'};
  }else{
    if(row.action!=='release.updated'&&row.action!=='reconcile.completed')return null;
    if(row.state==='succeeded'||row.state==='confirmed_absent')return {action:'resolved',outcome:'resolved',error:null};
    // A successful presence check clears the source error but does not resolve its incident or invent a new failure.
    if(row.error_code!==null&&(row.state==='unknown'||row.remote_status==='unknown'))return {action:'failed',outcome:'unknown',error:safeAlertErrorCode(row.error_code)??'cloudflare_delete_unknown'};
    if(row.error_code!==null&&row.state==='failed')return {action:'failed',outcome:'failed',error:safeAlertErrorCode(row.error_code)??'cloudflare_api_unavailable'};
  }
  return null;
}
/** Durable cursor, incident, occurrence and app events commit in the same D1 transaction; no network or DELETE. */
export async function projectCloudflareSuppressionAlerts(env:RuntimeEnv,options:{limit?:number;now?:()=>number}={}):Promise<{suppressionAlertsProjected:number}>{
  const config=cloudflareSuppressionIdentity(env);if(!config)return {suppressionAlertsProjected:0};
  const limit=options.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ServiceError('invalid_query',400);
  await sql(env,`INSERT INTO cloudflare_suppression_alert_cursors(account_id,domain,last_rowid) SELECT ?,?,last_rowid FROM cloudflare_suppression_alert_cursors WHERE account_id='' AND domain='' ON CONFLICT(account_id,domain) DO NOTHING`,config.accountId,config.domain).run();
  let previous=(await sql(env,'SELECT last_rowid FROM cloudflare_suppression_alert_cursors WHERE account_id=? AND domain=?',config.accountId,config.domain).first<{last_rowid:number}>())!.last_rowid;
  const rows=(await sql(env,'SELECT rowid AS journal_rowid,* FROM cloudflare_suppression_history_events WHERE account_id=? AND domain=? AND rowid>? ORDER BY rowid LIMIT ?',config.accountId,config.domain,previous,limit).all<Journal>()).results;
  let projected=0;
  for(const row of rows){
    const next=transition(row),root=next?await lineage(env,config,row):null,at=(options.now??Date.now)();
    const guard='EXISTS(SELECT 1 FROM cloudflare_suppression_alert_cursors WHERE account_id=? AND domain=? AND last_rowid=?)',args=[config.accountId,config.domain,previous] as const,batch:D1PreparedStatement[]=[];
    if(next&&root){
      const id=await stableId(`suppression-alert:${config.accountId}:${config.domain}:${row.kind}:${root.key}`),fingerprint=await sha256(JSON.stringify([row.resource_id,next.outcome,next.error]));
      if(next.action==='failed')batch.push(sql(env,`INSERT INTO cloudflare_suppression_alerts(id,account_id,domain,kind,group_key,mailbox_id,global_scope,status,outcome,version,generation,occurrences,error_code,first_occurred_at,last_occurred_at,source_id,last_fingerprint,last_journal_id)
        SELECT ?,?,?,?,?,?,?,'open',?,1,1,1,?,?,?,?,?,? WHERE ${guard}
        ON CONFLICT(id) DO UPDATE SET status='open',outcome=excluded.outcome,version=cloudflare_suppression_alerts.version+1,
        generation=cloudflare_suppression_alerts.generation+CASE WHEN cloudflare_suppression_alerts.status='resolved' THEN 1 ELSE 0 END,occurrences=cloudflare_suppression_alerts.occurrences+1,
        error_code=excluded.error_code,last_occurred_at=MAX(cloudflare_suppression_alerts.last_occurred_at,excluded.last_occurred_at),acknowledged_at=NULL,resolved_at=NULL,source_id=excluded.source_id,last_fingerprint=excluded.last_fingerprint,last_journal_id=excluded.last_journal_id
        WHERE cloudflare_suppression_alerts.last_fingerprint<>excluded.last_fingerprint AND NOT EXISTS(SELECT 1 FROM cloudflare_suppression_alert_occurrences WHERE alert_id=? AND journal_id=?)`,
        id,config.accountId,config.domain,row.kind,root.key,root.box,root.global?1:0,next.outcome,next.error,row.occurred_at,row.occurred_at,row.resource_id,fingerprint,row.id,...args,id,row.id));
      else batch.push(sql(env,`UPDATE cloudflare_suppression_alerts SET status='resolved',outcome='resolved',version=version+1,error_code=NULL,resolved_at=?,last_occurred_at=MAX(last_occurred_at,?),source_id=?,last_journal_id=?
        WHERE id=? AND status<>'resolved' AND ${guard} AND NOT EXISTS(SELECT 1 FROM cloudflare_suppression_alert_occurrences WHERE alert_id=? AND journal_id=?)`,row.occurred_at,row.occurred_at,row.resource_id,row.id,id,...args,id,row.id));
      batch.push(sql(env,`INSERT INTO cloudflare_suppression_alert_occurrences(id,alert_id,journal_id,action,outcome,version,error_code,occurred_at,source_id)
        SELECT ?,id,?,?,outcome,version,error_code,?,source_id FROM cloudflare_suppression_alerts WHERE id=? AND last_journal_id=? AND ${guard} ON CONFLICT(alert_id,journal_id) DO NOTHING`,crypto.randomUUID(),row.id,next.action,row.occurred_at,id,row.id,...args));
      const payload=JSON.stringify({alertId:id,kind:row.kind,status:next.action==='failed'?'open':'resolved',outcome:next.outcome,...(next.error?{errorCode:next.error}:{})}),type=`cloudflare.suppression.alert.${next.action==='failed'?'created':'resolved'}`;
      batch.push(sql(env,`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
        SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,'app',?,?,?,?,?
        FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id AND a.is_primary=1 AND a.status='active'
        WHERE m.status='active' AND m.created_at<=? AND substr(a.address,instr(a.address,'@')+1)=? AND (?=1 OR m.id=?) AND ${guard}
        AND EXISTS(SELECT 1 FROM cloudflare_suppression_alert_occurrences WHERE alert_id=? AND journal_id=?) ON CONFLICT(mailbox_id,source,source_event_id) DO NOTHING`,
        `suppression-alert:${id}:${row.id}:${next.action}`,type,payload,row.occurred_at,at,row.occurred_at,config.domain,root.global?1:0,root.box,...args,id,row.id));
    }
    batch.push(sql(env,`UPDATE cloudflare_suppression_alert_cursors SET last_rowid=? WHERE account_id=? AND domain=? AND last_rowid=?`,row.journal_rowid,config.accountId,config.domain,previous));
    const result=await env.DB.batch(batch);if(result.at(-1)!.meta.changes)projected++;previous=row.journal_rowid;
  }
  return {suppressionAlertsProjected:projected};
}

const visible="a.account_id=? AND a.domain=? AND(a.mailbox_id=? OR a.global_scope=1)";
const selectAlert=`SELECT a.*,COALESCE(s.mailbox_id,o.mailbox_id) AS source_mailbox_id FROM cloudflare_suppression_alerts a
  LEFT JOIN cloudflare_suppression_sync_runs s ON a.kind='sync' AND s.id=a.source_id AND s.account_id=a.account_id AND s.domain=a.domain
  LEFT JOIN cloudflare_suppression_operations o ON a.kind='release' AND o.id=a.source_id AND o.account_id=a.account_id AND o.domain=a.domain`;
export async function listCloudflareSuppressionAlerts(ctx:OwnerContext,box:string,query:{kind?:unknown;status?:unknown;limit?:unknown;cursor?:unknown}={}):Promise<CloudflareSuppressionAlertList>{
  const config=await authorize(ctx,box);objectInput(query,['kind','status','limit','cursor']);
  const kind=query.kind??'all',status=query.status??'open',limit=query.limit===undefined?20:Number(query.limit);
  if(!['all','sync','release'].includes(String(kind))||!['all','open','acknowledged','resolved'].includes(String(status))||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  if(!config)return {configured:false,alerts:[],nextCursor:null,summary:{open:0,acknowledged:0,resolved:0}};
  let before:{time:number;id:string}|null=null;
  if(query.cursor!==undefined){try{
    if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!value||Object.keys(value).length!==9||value.v!==1||value.account!==config.accountId||value.domain!==config.domain||value.box!==box||value.kind!==kind||value.status!==status||value.limit!==limit||!Number.isSafeInteger(value.time)||typeof value.id!=='string'||!uuid.test(value.id))throw Error();before={time:value.time,id:value.id};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const rows=(await sql(ctx.env,`${selectAlert} WHERE ${visible} ${kind==='all'?'':'AND a.kind=?'} ${status==='all'?'':'AND a.status=?'}
    ${before?'AND(a.last_occurred_at<? OR(a.last_occurred_at=? AND a.id<?))':''} ORDER BY a.last_occurred_at DESC,a.id DESC LIMIT ?`,config.accountId,config.domain,box,...(kind==='all'?[]:[String(kind)]),...(status==='all'?[]:[String(status)]),...(before?[before.time,before.time,before.id]:[]),limit+1).all<AlertRow>()).results;
  const counts=(await sql(ctx.env,`SELECT a.status,COUNT(*) AS count FROM cloudflare_suppression_alerts a WHERE ${visible} ${kind==='all'?'':'AND a.kind=?'} GROUP BY a.status`,config.accountId,config.domain,box,...(kind==='all'?[]:[String(kind)])).all<{status:'open'|'acknowledged'|'resolved';count:number}>()).results;
  const summary={open:0,acknowledged:0,resolved:0};for(const row of counts)summary[row.status]=row.count;
  const page=rows.slice(0,limit),last=page.at(-1),nextCursor=rows.length>limit&&last?btoa(JSON.stringify({v:1,account:config.accountId,domain:config.domain,box,kind,status,limit,time:last.last_occurred_at,id:last.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {configured:true,alerts:page.map(dto),nextCursor,summary};
}
export async function getCloudflareSuppressionAlert(ctx:OwnerContext,box:string,id:string):Promise<CloudflareSuppressionAlertDetail>{
  const config=await authorize(ctx,box);if(!config||!uuid.test(id))throw new ServiceError('not_found',404);
  const row=await sql(ctx.env,`${selectAlert} WHERE ${visible} AND a.id=?`,config.accountId,config.domain,box,id.toLowerCase()).first<AlertRow>();if(!row)throw new ServiceError('not_found',404);
  const timeline=(await sql(ctx.env,`SELECT t.*,s.mailbox_id AS source_mailbox_id FROM cloudflare_suppression_alert_occurrences t
    LEFT JOIN ${row.kind==='sync'?'cloudflare_suppression_sync_runs':'cloudflare_suppression_operations'} s ON s.id=t.source_id AND s.account_id=? AND s.domain=?
    WHERE t.alert_id=? ORDER BY t.version DESC LIMIT 101`,config.accountId,config.domain,row.id).all<{id:string;action:'failed'|'resolved';outcome:CloudflareSuppressionAlertOutcome;version:number;error_code:string|null;occurred_at:number;source_id:string;source_mailbox_id:string|null}>()).results;
  return {alert:dto(row),timeline:timeline.slice(0,100).reverse().map(event=>({id:event.id,action:event.action,outcome:event.outcome,version:event.version,errorCode:safeAlertErrorCode(event.error_code),occurredAt:event.occurred_at,source:{kind:row.kind,sourceId:event.source_id,...(event.source_mailbox_id?{mailboxId:event.source_mailbox_id}:{})}})),timelineTruncated:timeline.length>100};
}
export async function acknowledgeCloudflareSuppressionAlert(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<{alert:CloudflareSuppressionAlert}>{
  const config=await authorize(ctx,box);if(!config||!uuid.test(id))throw new ServiceError('not_found',404);const data=objectInput(input,['expectedVersion']);
  if(typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ServiceError('invalid_input',400);
  const at=Date.now(),claim=crypto.randomUUID();await ctx.env.DB.batch([
    sql(ctx.env,`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) SELECT ?,?,'owner','cloudflare_suppression_alert.acknowledged',?,'success',?,?
      WHERE EXISTS(SELECT 1 FROM cloudflare_suppression_alerts a WHERE ${visible} AND a.id=? AND a.status='open' AND a.version=?)`,claim,box,id,ctx.requestId,at,config.accountId,config.domain,box,id.toLowerCase(),data.expectedVersion),
    sql(ctx.env,`UPDATE cloudflare_suppression_alerts SET status='acknowledged',version=version+1,acknowledged_at=? WHERE id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,at,id.toLowerCase(),claim)
  ]);
  if(!await sql(ctx.env,'SELECT id FROM audit_events WHERE id=?',claim).first())throw new ServiceError('alert_changed',409);
  return {alert:(await getCloudflareSuppressionAlert(ctx,box,id)).alert};
}
