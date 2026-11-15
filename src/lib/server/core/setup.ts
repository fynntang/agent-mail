import type {SetupAttestations,SetupDTO,SetupProbeResult} from '../../types/setup';
import {sha256} from './crypto';
import {requireOwner,type OwnerContext} from './owner';
import {readBounded} from './storage';
import {ServiceError,type RuntimeEnv} from './types';

export const SETUP_MIGRATIONS=['0001_initial.sql','0002_oauth.sql','0003_setup.sql','0004_attachments.sql','0005_draft_attachments.sql','0006_webhooks.sql','0007_email_delivery_events.sql','0008_recipient_suppressions.sql','0009_cloudflare_suppressions.sql','0010_cloudflare_suppression_history.sql','0011_cloudflare_suppression_alerts.sql','0012_alert_notification_policies.sql','0013_alert_notification_decision_indexes.sql','0014_async_alert_notification_exports.sql','0015_async_export_notifications.sql','0016_export_notification_delivery_history.sql','0017_export_notification_retry_batches.sql','0018_export_notification_retry_controls.sql','0019_retry_batch_notifications.sql','0020_retry_batch_notification_retry_batches.sql'] as const;
const requiredColumns:Record<string,string[]>={
  retry_batch_notification_retry_batches:['id','mailbox_id','preview_request_id','request_hash','from_ms','to_ms','filter_reason','state','version','created_at','updated_at','expires_at','preview_expires_at','commit_request_id','commit_expected_version','committed_at','completed_at','cancelled_at','total_items','eligible_items','processed_items','requeued_items','skipped_items','failed_items','unknown_items'],
  retry_batch_notification_retry_items:['batch_id','mailbox_id','delivery_id','notification_id','source_batch_id','expected_updated_at','failure_reason','failed_at','preview_eligible','preview_reason','state','client_request_id','reason','manual_retry_id','created_at','updated_at','completed_at','lease_token','lease_until','version'],
  async_export_retry_batch_notifications:['endpoint_snapshot_json','id','mailbox_id','batch_id','kind','reason','source_version','batch_state','total_items','eligible_items','processed_items','requeued_items','skipped_items','failed_items','unknown_items','occurred_at','created_at','acknowledged_at','version','event_id','projected_at','notification_decision','policy_version','decided_at','claim_token'],
  async_export_notification_retry_batches:['id','mailbox_id','preview_request_id','request_hash','from_ms','to_ms','filter_reason','state','version','created_at','updated_at','expires_at','preview_expires_at','commit_request_id','commit_expected_version','committed_at','completed_at','total_items','eligible_items','processed_items','requeued_items','skipped_items','failed_items','unknown_items','cancelled_at'],
  async_export_notification_retry_items:['batch_id','mailbox_id','delivery_id','job_id','expected_updated_at','failure_reason','failed_at','preview_eligible','preview_reason','state','client_request_id','reason','manual_retry_id','created_at','updated_at','completed_at','lease_token','lease_until','version'],
  async_export_notifications:['job_id','mailbox_id','outcome','format','total_decisions','processed_decisions','processed_deliveries','body_bytes','error_code','completed_at','expires_at','created_at','acknowledged_at','version','event_id','projected_at','notification_decision','policy_version','decided_at','claim_token'],
  async_export_notification_state:['mailbox_id','fingerprint','last_notified_at'],
  async_alert_notification_exports:["id","mailbox_id","client_request_id","request_hash","format","filter_decision","filter_event_type","from_ms","to_ms","decision_watermark","total_decisions","processed_decisions","processed_deliveries","next_time","next_event_id","chunk_count","body_bytes","summary_json","state","error_code","version","created_at","updated_at","started_at","completed_at","expires_at","observed_from","observed_to","lease_token","lease_until","attempts","failures","available_at","cleanup_due_at","last_cleanup_at"],
  async_alert_notification_export_chunks:["job_id","mailbox_id","sequence","object_key","size_bytes","sha256","created_at"],
  alert_notification_policies:["mailbox_id","enabled","recovery_enabled","repeat_interval_seconds","quiet_enabled","quiet_start_minute","quiet_end_minute","time_zone","version","updated_at"],
  alert_notification_decisions:["event_id","mailbox_id","alert_id","decision","policy_version","decided_at","claim_token"],
  alert_notification_state:["mailbox_id","alert_id","fingerprint","last_notified_at"],
  attachments:["id","mailbox_id","message_id","object_id","part_id","filename","disposition","content_id","scan_status"],
  audit_events:["id","mailbox_id","actor_kind","token_id","action","resource_id","outcome","request_id","metadata_json","occurred_at"],
  cloudflare_suppression_cache:["account_id","configured_domain","remote_id","address","scope_type","scope_value","reason","read_only","status","version_hash","expires_at","provider_created_at","seen_at","updated_at","last_sync_id"],
  cloudflare_suppression_sync:["account_id","domain","lease_token","lease_until","last_attempt_at","last_success_at","last_error_code"],
  cloudflare_suppression_operations:["id","request_hash","account_id","domain","mailbox_id","remote_id","address","scope_type","scope_value","version_hash","release_local","local_id","local_version","state","remote_status","local_status","lease_token","lease_until","created_at","updated_at","completed_at","error_code","retry_of","verified_at","verified_read_only","verified_version"],
  cloudflare_suppression_sync_runs:["id","request_hash","account_id","domain","mailbox_id","source","retry_of","state","count","error_code","started_at","completed_at","lease_token","lease_until"],
  cloudflare_suppression_reconciliations:["id","request_hash","operation_id","account_id","domain","mailbox_id","state","error_code","started_at","completed_at","lease_token","lease_until"],
  cloudflare_suppression_history_events:["id","account_id","domain","kind","resource_id","action","state","remote_status","local_status","error_code","count","occurred_at"],
  cloudflare_suppression_alert_cursors:["account_id","domain","last_rowid"],
  cloudflare_suppression_alerts:["id","account_id","domain","kind","group_key","mailbox_id","global_scope","status","outcome","version","generation","occurrences","error_code","first_occurred_at","last_occurred_at","acknowledged_at","resolved_at","source_id","last_fingerprint","last_journal_id"],
  cloudflare_suppression_alert_occurrences:["id","alert_id","journal_id","action","outcome","version","error_code","occurred_at","source_id"],
  daily_send_counters:["id","mailbox_id","day_utc","limit_snapshot","reserved_units","used_units"],
  draft_attachments:["id","mailbox_id","draft_id","object_id","filename","content_type","size_bytes","sha256","scan_status","created_at"],
  draft_attachment_uploads:["id","mailbox_id","draft_id","created_by_token_id","expected_version","filename","content_type","total_bytes","received_bytes","state","attachment_id","created_at","expires_at"],
  draft_attachment_upload_parts:["upload_id","mailbox_id","offset_bytes","size_bytes","object_key","sha256","created_at"],
  drafts:["id","mailbox_id","content_object_id","created_by_token_id","version","state","content_sha256","approved_version","approved_sha256","approved_at","created_at","updated_at"],
  email_delivery_events:["id","account_id","event_id","zone_id","subscription_id","domain","provider_message_id","sender","recipient","event_type","event_at","terminal","canonical_sha256","state","mailbox_id","outbound_id","received_at","expires_at","next_attempt_at","reconcile_attempts","applied_at","ignore_reason","bounce_type","evidence_version","suppression_applied_at"],
  events:["id","mailbox_id","source","source_event_id","type","payload_json","occurred_at","created_at","webhook_published_at"],
  idempotency_keys:["id","mailbox_id","principal_key","operation","key","request_sha256","state","resource_id","response_json","created_at","expires_at"],
  ingest_receipts:["id","mailbox_id","raw_object_id","provider_delivery_key","envelope_from","envelope_to","status","error_code","received_at"],
  instance_settings:["id","instance_id","display_name","setup_state","app_version","created_at","updated_at","setup_checks_json","setup_config_sha256"],
  jobs:["id","mailbox_id","kind","dedupe_key","payload_json","state","available_at","lease_token","lease_until","attempts","max_attempts","last_error_code","created_at"],
  mailbox_addresses:["id","mailbox_id","address","is_primary","status","created_at","retired_at"],
  mailbox_tokens:["id","mailbox_id","name","secret_sha256","can_read","can_read_attachments","can_draft","can_send","requires_approval","expires_at","revoked_at","last_used_at","created_at"],
  mailboxes:["id","name","status","daily_recipient_limit","max_message_bytes","allowed_recipients_json","created_at","updated_at","deleted_at"],
  message_addresses:["id","mailbox_id","message_id","kind","ordinal","address","display_name"],
  messages:["id","mailbox_id","thread_id","ingest_receipt_id","raw_object_id","body_object_id","rfc_message_id","in_reply_to","subject","preview","direction","folder","is_read","parse_state","size_bytes","received_at","deleted_at","attachments_state"],
  oauth_access_tokens:["id","grant_id","secret_sha256","scope","created_at","expires_at","revoked_at"],
  oauth_authorization_codes:["id","grant_id","secret_sha256","redirect_uri","code_challenge","created_at","expires_at","used_at"],
  oauth_authorization_requests:["id","client_id","redirect_uri","resource","requested_scope","state","code_challenge","owner_email","csrf_sha256","created_at","expires_at","used_at"],
  oauth_clients:["client_id","kind","client_name","redirect_uris_json","scope","status","created_at","metadata_expires_at"],
  oauth_grants:["id","client_id","mailbox_id","mailbox_token_id","resource","scope","created_at","expires_at","revoked_at"],
  oauth_refresh_tokens:["id","grant_id","secret_sha256","scope","created_at","expires_at","used_at","revoked_at","replaced_by_id"],
  oauth_registration_windows:["window_start","count"],
  objects:["id","mailbox_id","object_key","purpose","state","size_bytes","sha256","content_type","created_at","ready_at"],
  outbound_messages:["id","mailbox_id","sender_address_id","draft_id","requested_by_token_id","frozen_object_id","reservation_id","request_sha256","status","provider","provider_message_id","accepted_at","last_error_code","created_at","updated_at"],
  outbound_recipients:["id","mailbox_id","outbound_id","kind","address","status","last_provider_event_at","diagnostic_redacted","last_provider_event_id","delivery_event_type","complained_at","last_delivery_event_at","last_delivery_event_id"],
  recipient_suppressions:["id","mailbox_id","address","status","reason","version","last_event_at","last_event_id","created_at","updated_at","released_at","release_watermark"],
  send_attempts:["id","mailbox_id","outbound_id","attempt_no","lease_token","outcome","error_code","started_at","finished_at"],
  send_reservations:["id","mailbox_id","counter_id","operation_id","units","state","created_at","settled_at"],
  threads:["id","mailbox_id","subject","last_message_at","created_at"],
  webhook_deliveries:["id","mailbox_id","endpoint_id","event_id","state","attempts","available_at","lease_token","lease_until","signed_secret_version","signing_secret_ciphertext","last_http_status","created_at","url_snapshot","payload_json","last_error_code","completed_at","updated_at","attempt_budget"],
  webhook_endpoints:["id","mailbox_id","url","event_types_json","signing_secret_ciphertext","secret_version","status","created_at","updated_at","event_after_rowid"],
  webhook_delivery_attempts:["id","mailbox_id","delivery_id","attempt_no","lease_token","outcome","http_status","error_code","started_at","finished_at"]
};
const requiredIndexes:Record<string,{table:string;columns:string[]}>= {
  retry_batch_notifications_target:{table:'async_export_retry_batch_notifications',columns:['mailbox_id','id','batch_id']},
  notice_retry_batch_mailbox:{table:'retry_batch_notification_retry_batches',columns:['mailbox_id','created_at','id']},
  notice_retry_batch_claim:{table:'retry_batch_notification_retry_batches',columns:['state','updated_at','id']},
  notice_retry_item_claim:{table:'retry_batch_notification_retry_items',columns:['state','updated_at','batch_id','delivery_id']},
  notice_retry_item_batch:{table:'retry_batch_notification_retry_items',columns:['batch_id','delivery_id']},
  retry_batch_notifications_mailbox:{table:'async_export_retry_batch_notifications',columns:['mailbox_id','created_at','id']},
  retry_batch_notifications_unread:{table:'async_export_retry_batch_notifications',columns:['mailbox_id','acknowledged_at','created_at','id']},
  retry_batch_notifications_project:{table:'async_export_retry_batch_notifications',columns:['projected_at','created_at','id']},
  export_retry_batch_mailbox:{table:'async_export_notification_retry_batches',columns:['mailbox_id','created_at','id']},
  export_retry_batch_claim:{table:'async_export_notification_retry_batches',columns:['state','updated_at','id']},
  export_retry_item_claim:{table:'async_export_notification_retry_items',columns:['state','updated_at','batch_id','delivery_id']},
  export_retry_item_batch:{table:'async_export_notification_retry_items',columns:['batch_id','delivery_id']},
  audit_resource_history:{table:'audit_events',columns:['mailbox_id','resource_id','action','occurred_at','id']},
  async_export_notifications_mailbox:{table:'async_export_notifications',columns:['mailbox_id','created_at','job_id']},
  async_export_notifications_unread:{table:'async_export_notifications',columns:['mailbox_id','acknowledged_at','created_at','job_id']},
  async_export_notifications_project:{table:'async_export_notifications',columns:['projected_at','created_at','job_id']},
  alert_notification_decision_reason:{table:'alert_notification_decisions',columns:['mailbox_id','decision','decided_at','event_id']},
  webhook_event_deliveries:{table:'webhook_deliveries',columns:['mailbox_id','event_id']}
};
const emptyChecks=():SetupAttestations=>({mailDomain:false,access:false,emailRouting:false,emailSending:false});
const checksKeys=['mailDomain','access','emailRouting','emailSending'] as const;
interface SettingsRow {instance_id:string;display_name:string;setup_state:SetupDTO['instance']['state'];updated_at:number;setup_checks_json:string;setup_config_sha256:string|null}

function objectInput(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))) throw new ServiceError('invalid_input',400);
  return value as Record<string,unknown>;
}
function attestations(value:unknown):SetupAttestations {
  const input=objectInput(value,[...checksKeys]);
  if(checksKeys.some(key=>typeof input[key]!=='boolean')) throw new ServiceError('invalid_input',400);
  return {mailDomain:input.mailDomain as boolean,access:input.access as boolean,emailRouting:input.emailRouting as boolean,emailSending:input.emailSending as boolean};
}
function savedChecks(value:string):{checks:SetupAttestations;valid:boolean} {
  try{return {checks:attestations(JSON.parse(value)),valid:true};}catch{return {checks:emptyChecks(),valid:false};}
}
function deploymentConfig(env:RuntimeEnv):SetupDTO['config'] {
  return {mailDomain:env.MAIL_DOMAIN??'',consoleOrigin:env.CONSOLE_ORIGIN??'',apiOrigin:env.API_ORIGIN??'',ownerEmail:env.OWNER_EMAIL??'',
    accessTeamDomain:env.ACCESS_TEAM_DOMAIN??'',accessAud:env.ACCESS_AUD??'',sendingEnabled:Boolean(env.EMAIL)};
}
function validDomain(value:string):boolean {
  return value.length<=253&&value.includes('.')&&value===value.toLowerCase()&&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
function validOrigin(value:string):boolean {
  try {
    const url=new URL(value),loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    return url.origin===value&&!url.username&&!url.password&&(url.protocol==='https:'||(url.protocol==='http:'&&loopback));
  }catch{return false;}
}
function configIsValid(config:SetupDTO['config']):boolean {
  try {
    const team=new URL(config.accessTeamDomain);
    return validDomain(config.mailDomain)&&validOrigin(config.consoleOrigin)&&validOrigin(config.apiOrigin)
      &&!/CHANGE_ME/i.test(JSON.stringify(config))&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ownerEmail)
      &&team.protocol==='https:'&&/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team.hostname)&&team.pathname==='/'
      &&!team.username&&!team.password&&!team.port&&!team.search&&!team.hash&&Boolean(config.accessAud.trim())&&config.accessAud.length<=1024
      &&!/[\x00-\x1f\x7f]/.test(config.accessAud);
  }catch{return false;}
}
function manualComplete(checks:SetupAttestations,sending:boolean):boolean {
  return checks.mailDomain&&checks.access&&checks.emailRouting&&(!sending||checks.emailSending);
}
async function schemaHealth(env:RuntimeEnv):Promise<Pick<SetupDTO['resources'],'d1'|'schemaVersion'|'missingTables'|'missingIndexes'>> {
  try {
    const tables=Object.keys(requiredColumns),indexes=Object.keys(requiredIndexes),indexOffset=tables.length+1;
    // All identifiers below are fixed application constants, never supplied by callers.
    const info=await env.DB.batch([env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'"),
      ...tables.map(table=>env.DB.prepare(`PRAGMA table_info(${table})`)),
      env.DB.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type='index'"),
      ...indexes.map(index=>env.DB.prepare(`PRAGMA index_info(${index})`))]);
    const actualTables=new Set((info[0].results as {name:string}[]).map(table=>table.name));
    const columns=new Map(tables.map((table,index)=>[table,new Set((info[index+1].results as {name:string}[]).map(column=>column.name))]));
    const has=(table:string,names=requiredColumns[table])=>actualTables.has(table)&&names.every(name=>columns.get(table)?.has(name));
    const missing=tables.filter(table=>!has(table));
    const actualIndexes=new Map((info[indexOffset].results as {name:string;tbl_name:string}[]).map(index=>[index.name,index.tbl_name]));
    const missingIndexes=indexes.filter((name,index)=>{
      const expected=requiredIndexes[name],actual=(info[indexOffset+index+1].results as {seqno:number;name:string}[]).sort((a,b)=>a.seqno-b.seqno).map(column=>column.name);
      return actualIndexes.get(name)!==expected.table||actual.length!==expected.columns.length||actual.some((column,position)=>column!==expected.columns[position]);
    });
    const deliveryColumns=['last_provider_event_id','delivery_event_type','complained_at','last_delivery_event_at','last_delivery_event_id'];
    const additions:Record<string,string[]>={outbound_recipients:deliveryColumns,events:['webhook_published_at'],webhook_endpoints:['updated_at','event_after_rowid'],webhook_deliveries:['url_snapshot','payload_json','last_error_code','completed_at','updated_at','attempt_budget']};
    const base=tables.filter(table=>!table.startsWith('oauth_')&&!table.startsWith('draft_attachment')&&!table.startsWith('cloudflare_suppression_')&&!table.startsWith('alert_notification_')&&!table.startsWith('async_alert_notification_')&&!table.startsWith('async_export_')&&!table.startsWith('retry_batch_notification_retry_')&&table!=='webhook_delivery_attempts'&&table!=='email_delivery_events'&&table!=='recipient_suppressions');
    const baseReady=base.every(table=>has(table,requiredColumns[table].filter(column=>!(additions[table]??[]).includes(column)
      &&(table==='instance_settings'?!column.startsWith('setup_checks_')&&column!=='setup_config_sha256':table==='messages'?column!=='attachments_state':true))));
    const oauthReady=baseReady&&tables.filter(table=>table.startsWith('oauth_')).every(table=>has(table));
    const setupReady=oauthReady&&has('instance_settings');
    const attachmentsReady=setupReady&&has('messages');
    const draftsReady=attachmentsReady&&tables.filter(table=>table.startsWith('draft_attachment')).every(table=>has(table));
    const webhooksReady=draftsReady&&has('events')&&has('webhook_endpoints')&&has('webhook_deliveries')&&has('webhook_delivery_attempts');
    const deliveryReady=webhooksReady&&has('outbound_recipients')&&has('email_delivery_events',requiredColumns.email_delivery_events.filter(column=>!['bounce_type','evidence_version','suppression_applied_at'].includes(column)));
    const localSuppressionReady=deliveryReady&&has('email_delivery_events')&&has('recipient_suppressions');
    const providerReady=localSuppressionReady&&has('cloudflare_suppression_cache')&&has('cloudflare_suppression_sync')
      &&has('cloudflare_suppression_operations',requiredColumns.cloudflare_suppression_operations.filter(column=>!['retry_of','verified_at','verified_read_only','verified_version'].includes(column)));
    const historyReady=providerReady&&has('cloudflare_suppression_operations')&&has('cloudflare_suppression_sync_runs')
      &&has('cloudflare_suppression_reconciliations')&&has('cloudflare_suppression_history_events');
    const alertsReady=historyReady&&has('cloudflare_suppression_alert_cursors')&&has('cloudflare_suppression_alerts')&&has('cloudflare_suppression_alert_occurrences');
    const policiesReady=alertsReady&&has('alert_notification_policies')&&has('alert_notification_decisions')&&has('alert_notification_state');
    const decisionIndexesReady=!['alert_notification_decision_reason','webhook_event_deliveries'].some(index=>missingIndexes.includes(index));
    const asyncExportsReady=policiesReady&&decisionIndexesReady&&has('async_alert_notification_exports')&&has('async_alert_notification_export_chunks');
    const exportNotificationsReady=asyncExportsReady&&has('async_export_notifications')&&has('async_export_notification_state')
      &&!['async_export_notifications_mailbox','async_export_notifications_unread','async_export_notifications_project'].some(index=>missingIndexes.includes(index));
    const exportDeliveryHistoryReady=exportNotificationsReady&&!missingIndexes.includes('audit_resource_history');
    const retryBatchesReady=exportDeliveryHistoryReady&&has('async_export_notification_retry_batches',requiredColumns.async_export_notification_retry_batches.filter(column=>column!=='cancelled_at'))
      &&has('async_export_notification_retry_items')&&!['export_retry_batch_mailbox','export_retry_batch_claim','export_retry_item_claim','export_retry_item_batch'].some(index=>missingIndexes.includes(index));
    const retryControlsReady=retryBatchesReady&&has('async_export_notification_retry_batches');
    const retryNoticesReady=retryControlsReady&&has('async_export_retry_batch_notifications')&&!['retry_batch_notifications_mailbox','retry_batch_notifications_unread','retry_batch_notifications_project'].some(index=>missingIndexes.includes(index));
    return {d1:missing.length||missingIndexes.length?'migration_required':'migrated',schemaVersion:!missing.length&&!missingIndexes.length?'0020_retry_batch_notification_retry_batches.sql':retryNoticesReady?'0019_retry_batch_notifications.sql':retryControlsReady?'0018_export_notification_retry_controls.sql':retryBatchesReady?'0017_export_notification_retry_batches.sql':exportDeliveryHistoryReady?'0016_export_notification_delivery_history.sql':exportNotificationsReady?'0015_async_export_notifications.sql':asyncExportsReady?'0014_async_alert_notification_exports.sql':policiesReady?(decisionIndexesReady?'0013_alert_notification_decision_indexes.sql':'0012_alert_notification_policies.sql'):alertsReady?'0011_cloudflare_suppression_alerts.sql':historyReady?'0010_cloudflare_suppression_history.sql':providerReady?'0009_cloudflare_suppressions.sql':localSuppressionReady?'0008_recipient_suppressions.sql':deliveryReady?'0007_email_delivery_events.sql':webhooksReady?'0006_webhooks.sql':draftsReady?'0005_draft_attachments.sql':attachmentsReady?'0004_attachments.sql':setupReady?'0003_setup.sql':oauthReady?'0002_oauth.sql':baseReady?'0001_initial.sql':null,missingTables:missing,missingIndexes};
  }catch{return {d1:'unavailable',schemaVersion:null,missingTables:[],missingIndexes:[]};}
}

/** Read-only: no singleton creation, probes, emails, DNS or Cloudflare administration calls. */
export async function getSetup(ctx:OwnerContext):Promise<SetupDTO> {
  requireOwner(ctx.actor);
  const config=deploymentConfig(ctx.env),fingerprint=await sha256(JSON.stringify(config)),configValid=configIsValid(config);
  const health=await schemaHealth(ctx.env);
  let r2:SetupDTO['resources']['r2']='connected';
  try {await ctx.env.MAIL_BLOBS.head('__agent_mail_binding_probe__');}catch{r2='unavailable';}
  let row:SettingsRow|null=null;
  if(health.d1==='migrated') {
    try {row=await ctx.env.DB.prepare('SELECT instance_id,display_name,setup_state,updated_at,setup_checks_json,setup_config_sha256 FROM instance_settings WHERE id=1').first<SettingsRow>();}
    catch {health.d1='unavailable';}
  }
  const stored=row?savedChecks(row.setup_checks_json):{checks:emptyChecks(),valid:true};
  const configChanged=Boolean(row&&row.setup_config_sha256!==fingerprint);
  const checks=configChanged?emptyChecks():stored.checks;
  const evidence={activeMailboxCount:0,inboundCount:0,acceptedSendCount:0};
  if(health.d1==='migrated') {
    try {
      const counts=await ctx.env.DB.prepare(`SELECT (SELECT count(*) FROM mailboxes WHERE status='active') activeMailboxCount,
        (SELECT count(*) FROM ingest_receipts WHERE status IN('stored','indexed')) inboundCount,
        (SELECT count(*) FROM outbound_messages WHERE accepted_at IS NOT NULL) acceptedSendCount`).first<typeof evidence>();
      if(counts) Object.assign(evidence,counts);
    }catch{health.d1='unavailable';}
  }
  const healthy=health.d1==='migrated'&&r2==='connected'&&configValid&&stored.valid;
  const canComplete=healthy&&manualComplete(checks,config.sendingEnabled)&&evidence.activeMailboxCount>0;
  const state=row?.setup_state==='maintenance'?'maintenance':row?.setup_state==='ready'&&canComplete?'ready':'pending';
  return {instance:{id:row?.instance_id??null,displayName:row?.display_name??'Agent Mail',state,updatedAt:row?.updated_at??null},
    config,resources:{...health,r2,expectedMigrations:[...SETUP_MIGRATIONS]},attestations:checks,evidence,configValid,configFingerprint:fingerprint,canComplete,configChanged};
}

/** Explicit Owner operation. The unpredictable probe key cannot overlap any mail object. */
export async function probeSetup(ctx:OwnerContext):Promise<SetupProbeResult> {
  requireOwner(ctx.actor);
  const key=`__agent_mail_setup_probe__/${crypto.randomUUID()}`,value=crypto.randomUUID();
  let verified=false,cleaned=false;
  try {
    await ctx.env.MAIL_BLOBS.put(key,value,{httpMetadata:{contentType:'text/plain'}});
    const object=await ctx.env.MAIL_BLOBS.get(key);
    verified=Boolean(object&&new TextDecoder().decode(await readBounded(object.body,128))===value);
  }catch {verified=false;}
  finally {try{await ctx.env.MAIL_BLOBS.delete(key);cleaned=true;}catch{cleaned=false;}}
  return !cleaned?{success:false,code:'cleanup_failed'}:verified?{success:true,code:'verified'}:{success:false,code:'probe_failed'};
}

export async function updateSetup(ctx:OwnerContext,input:unknown):Promise<SetupDTO> {
  requireOwner(ctx.actor);
  const data=objectInput(input,['expectedUpdatedAt','expectedConfigFingerprint','displayName','attestations','complete']);
  if(data.expectedUpdatedAt!==null&&(typeof data.expectedUpdatedAt!=='number'||!Number.isSafeInteger(data.expectedUpdatedAt)||data.expectedUpdatedAt<0)) throw new ServiceError('invalid_input',400);
  if(typeof data.expectedConfigFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(data.expectedConfigFingerprint)) throw new ServiceError('invalid_input',400);
  if(typeof data.displayName!=='string'||!data.displayName.trim()||data.displayName.trim().length>80||/[\x00-\x1f\x7f]/.test(data.displayName)) throw new ServiceError('invalid_name',400);
  if(data.complete!==undefined&&typeof data.complete!=='boolean') throw new ServiceError('invalid_input',400);
  const checks=attestations(data.attestations),current=await getSetup(ctx);
  if(current.configFingerprint!==data.expectedConfigFingerprint) throw new ServiceError('setup_config_changed',409);
  if(current.instance.updatedAt!==data.expectedUpdatedAt) throw new ServiceError('setup_changed',409);
  if(current.resources.d1!=='migrated') throw new ServiceError('setup_migration_required',409);
  if(data.complete===true) {
    if(current.resources.r2!=='connected'||!current.configValid||!manualComplete(checks,current.config.sendingEnabled)||current.evidence.activeMailboxCount<1) throw new ServiceError('setup_incomplete',409);
    if(!(await probeSetup(ctx)).success) throw new ServiceError('setup_probe_failed',503);
  }
  const now=Math.max(Date.now(),(current.instance.updatedAt??0)+1),id=current.instance.id??crypto.randomUUID(),claim=crypto.randomUUID();
  const fingerprint=current.configFingerprint,complete=data.complete===true;
  const guard=current.instance.updatedAt===null?'NOT EXISTS(SELECT 1 FROM instance_settings WHERE id=1)':'EXISTS(SELECT 1 FROM instance_settings WHERE id=1 AND updated_at=?)';
  const args=current.instance.updatedAt===null?[]:[current.instance.updatedAt];
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
      SELECT ?,'owner',?,?,'success',?,?,? WHERE ${guard}${complete?" AND EXISTS(SELECT 1 FROM mailboxes WHERE status='active')":''}`)
      .bind(claim,complete?'setup.completed':'setup.updated',id,ctx.requestId,JSON.stringify({attestations:checks,configFingerprint:fingerprint}),now,...args),
    current.instance.updatedAt===null?
      ctx.env.DB.prepare(`INSERT INTO instance_settings(id,instance_id,display_name,setup_state,app_version,created_at,updated_at,setup_checks_json,setup_config_sha256)
        SELECT 1,?,?,?,'0.1.0',?,?,?,? WHERE ${owned}`).bind(id,data.displayName.trim(),complete?'ready':'pending',now,now,JSON.stringify(checks),fingerprint,claim):
      ctx.env.DB.prepare(`UPDATE instance_settings SET display_name=?,setup_state=?,updated_at=?,setup_checks_json=?,setup_config_sha256=? WHERE id=1 AND ${owned}`)
        .bind(data.displayName.trim(),complete?'ready':'pending',now,JSON.stringify(checks),fingerprint,claim)
  ]);
  if(result[1].meta.changes!==1) throw new ServiceError('setup_changed',409);
  return getSetup(ctx);
}
