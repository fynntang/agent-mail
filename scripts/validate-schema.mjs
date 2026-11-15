// 本地 SQLite 结构验证；不连接 Cloudflare，不部署应用。
// Node.js 24+；node scripts/validate-schema.mjs [--dictionary]
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, access, readdir } from 'node:fs/promises';

const migrationDirectory=new URL('../migrations/',import.meta.url);
const migrationNames=(await readdir(migrationDirectory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
const migrationTexts=await Promise.all(migrationNames.map(name=>readFile(new URL(name,migrationDirectory),'utf8')));
const sql=migrationTexts.map(value=>value.trim()).join('\n\n');
if(process.argv.includes('--dictionary'))await writeFile(new URL('../docs/schema.sql',import.meta.url),sql+'\n');
assert.equal(sql.trim(),(await readFile(new URL('../docs/schema.sql',import.meta.url),'utf8')).trim(),'迁移与快照必须一致');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON;');
const checks = [];
const now = 1794528000000;
const hash = 'a'.repeat(64);
const get = (q,...args) => db.prepare(q).get(...args);
const run = (q,...args) => db.prepare(q).run(...args);
const test = (label,fn) => { fn(); checks.push(label); };
const reject = (label,fn) => {
  test(label,()=>assert.throws(fn,error=>error.code==='ERR_SQLITE_ERROR' && (error.errcode & 255)===19));
};
const atomic = fn => {
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); } catch(error) { db.exec('ROLLBACK'); throw error; }
};
try {
 db.exec(sql);
 const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
 assert.equal(tables.length,54);
 test('54张个人版表加载，全部STRICT',()=>assert.ok(tables.every(t=>t.sql.trim().endsWith('STRICT'))));
 test('不包含租户、订阅或引擎账户表',()=>assert.ok(!tables.some(t=>/tenant|subscription|engine|user_sessions/.test(t.name))));
 test('外键检查已启用',()=>assert.equal(get('PRAGMA foreign_keys').foreign_keys,1));
 run("INSERT INTO instance_settings(id,instance_id,display_name,app_version,created_at,updated_at) VALUES(1,'instance','Owner','0.0.0',?,?)",now,now);
 reject('实例设置只能有一个Owner实例行',()=>run("INSERT INTO instance_settings(id,instance_id,display_name,app_version,created_at,updated_at) VALUES(2,'other','X','0',?,?)",now,now));
 test('初始化增量迁移保留旧实例并默认未确认',()=>{
  const settings=get('SELECT instance_id,setup_checks_json,setup_config_sha256 FROM instance_settings WHERE id=1');
  assert.equal(settings.instance_id,'instance');assert.deepEqual(JSON.parse(settings.setup_checks_json),{});assert.equal(settings.setup_config_sha256,null);
 });
 reject('初始化确认字段只能是JSON对象',()=>run("UPDATE instance_settings SET setup_checks_json='[]' WHERE id=1"));
 reject('初始化配置指纹不能保存任意文本',()=>run("UPDATE instance_settings SET setup_config_sha256='plaintext' WHERE id=1"));
 test('初始化确认与配置摘要可随Owner保存',()=>{
  run("UPDATE instance_settings SET setup_checks_json=?,setup_config_sha256=? WHERE id=1",JSON.stringify({mailDomain:true,access:true,emailRouting:false,emailSending:false}),hash);
  assert.equal(JSON.parse(get('SELECT setup_checks_json FROM instance_settings WHERE id=1').setup_checks_json).access,true);
  assert.equal(get('SELECT setup_config_sha256 FROM instance_settings WHERE id=1').setup_config_sha256,hash);
 });
 const mailbox = id=>run("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES(?,?,?,?)",id,id,now,now);
 mailbox('a'); mailbox('b');
 test('一个实例支持多个邮箱',()=>assert.equal(get('SELECT count(*) n FROM mailboxes').n,2));
 reject('TEXT主键显式拒绝NULL',()=>run("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES(NULL,'bad',?,?)",now,now));
 const address = (id,box,email,primary=0)=>run("INSERT INTO mailbox_addresses(id,mailbox_id,address,is_primary,created_at) VALUES(?,?,?,?,?)",id,box,email,primary,now);
 address('addr-a','a','a@agent.example',1); address('addr-b','b','b@agent.example',1);
 reject('邮箱不能有两个主地址',()=>address('primary2','a','second@agent.example',1));
 address('old','a','old@agent.example');
 run("UPDATE mailbox_addresses SET status='retired',retired_at=? WHERE id='old'",now);
 reject('退役地址不能被另一邮箱接管',()=>address('reused','b','old@agent.example'));
 reject('地址墓碑不能删除',()=>run("DELETE FROM mailbox_addresses WHERE id='old'"));
 reject('地址归属不能修改',()=>run("UPDATE mailbox_addresses SET mailbox_id='b' WHERE id='old'"));
 reject('退役地址不能重新激活',()=>run("UPDATE mailbox_addresses SET status='active' WHERE id='old'"));
 const token=(id,box,h=hash)=>run("INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,created_at) VALUES(?,?,?,?,?)",id,box,id,h,now);
 token('token-a','a'); token('token-b','b','b'.repeat(64));
 reject('Token不能跨邮箱迁移',()=>run("UPDATE mailbox_tokens SET mailbox_id='b' WHERE id='token-a'"));
 reject('Token摘要必须是64位小写hex',()=>token('badtoken','a','not-a-digest'));
 reject('没有任何权限的Token被拒绝',()=>run("INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,can_read,created_at) VALUES('empty','a','empty',?,0,?)",'c'.repeat(64),now));
 reject('附件权限不能绕过邮件读取权限',()=>run("INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,can_read,can_read_attachments,can_draft,created_at) VALUES('bad-attachment','a','bad',?,0,1,1,?)",'d'.repeat(64),now));
 reject('Token不能在创建前过期',()=>run("INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,expires_at,created_at) VALUES('expired','a','expired',?,?,?)",'e'.repeat(64),now-1,now));
 const object=(id,box,purpose='raw_email',state='ready')=>run("INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at) VALUES(?,?,?,?,?,10,?,'application/octet-stream',?,?)",id,box,box+'/'+id,purpose,state,state==='ready'?hash:null,now,state==='ready'?now:null);
 object('raw-a','a'); object('raw-a2','a'); object('raw-b','b'); object('draft-a','a','draft'); object('frozen-a','a','outbound');
 reject('R2对象key和邮箱不能修改',()=>run("UPDATE objects SET mailbox_id='b' WHERE id='raw-a'"));
 reject('持久对象的内容摘要不能重写',()=>run("UPDATE objects SET sha256=? WHERE id='raw-a'",'f'.repeat(64)));
 reject('ready对象需要明确摘要与完成时间',()=>run("INSERT INTO objects(id,mailbox_id,object_key,purpose,state,content_type,created_at) VALUES('incomplete','a','a/incomplete','raw_email','ready','text/plain',?)",now));
 const message=(id,box,raw,receipt=null)=>run("INSERT INTO messages(id,mailbox_id,raw_object_id,ingest_receipt_id,rfc_message_id,direction,size_bytes,received_at) VALUES(?,?,?,?,'<same@example.test>','inbound',10,?)",id,box,raw,receipt,now);
 message('msg-a','a','raw-a'); message('msg-a2','a','raw-a2'); message('msg-b','b','raw-b');
 test('旧邮件附件状态默认为未提取，不能把空列表当成已解析',()=>assert.equal(get("SELECT attachments_state FROM messages WHERE id='msg-a'").attachments_state,'not_extracted'));
 reject('附件提取状态拒绝任意值',()=>run("UPDATE messages SET attachments_state='clean' WHERE id='msg-a'"));
 test('附件提取状态与扫描状态分别保存',()=>{
  run("UPDATE messages SET attachments_state='ready' WHERE id='msg-a'");
  assert.equal(get("SELECT attachments_state FROM messages WHERE id='msg-a'").attachments_state,'ready');
 });
 test('重复Message-ID不会丢邮件',()=>assert.equal(get("SELECT count(*) n FROM messages WHERE mailbox_id='a' AND rfc_message_id='<same@example.test>'").n,2));
 reject('邮件不能引用其他邮箱对象',()=>message('cross','a','raw-b'));
 run("INSERT INTO ingest_receipts(id,mailbox_id,raw_object_id,envelope_from,envelope_to,received_at) VALUES('receipt','a','raw-a','sender@example.net','a@agent.example',?)",now);
 message('receipt-message','a','raw-a','receipt');
 reject('同一收信receipt不会重复索引',()=>message('receipt-duplicate','a','raw-a','receipt'));
 reject('附件不能跨邮箱引用邮件',()=>run("INSERT INTO attachments(id,mailbox_id,message_id,object_id,part_id) VALUES('att','b','msg-a','raw-b','1')"));
 reject('草稿不能使用其他邮箱Token身份',()=>run("INSERT INTO drafts(id,mailbox_id,content_object_id,created_by_token_id,content_sha256,created_at,updated_at) VALUES('draft','a','draft-a','token-b',?,?,?)",hash,now,now));
 reject('已审批草稿不能缺少版本',()=>run("INSERT INTO drafts(id,mailbox_id,content_object_id,state,content_sha256,approved_sha256,approved_at,created_at,updated_at) VALUES('approved','a','draft-a','approved',?,?,?,?,?)",hash,hash,now,now,now));
 run("INSERT INTO drafts(id,mailbox_id,content_object_id,content_sha256,created_at,updated_at) VALUES('attachment-draft','a','draft-a',?,?,?)",hash,now,now);
 object('upload-object','a','attachment');
 run("INSERT INTO draft_attachments(id,mailbox_id,draft_id,object_id,filename,content_type,size_bytes,sha256,created_at) VALUES('uploaded','a','attachment-draft','upload-object','report.bin','application/octet-stream',10,?,?)",hash,now);
 reject('草稿附件不能跨邮箱关联草稿或对象',()=>run("INSERT INTO draft_attachments(id,mailbox_id,draft_id,object_id,filename,content_type,size_bytes,sha256,created_at) VALUES('cross-upload','b','attachment-draft','raw-b','x','application/octet-stream',10,?,?)",hash,now));
 reject('草稿附件身份与摘要不可修改',()=>run("UPDATE draft_attachments SET sha256=? WHERE id='uploaded'",'b'.repeat(64)));
 test('草稿附件扫描标记独立于不可变内容',()=>{run("UPDATE draft_attachments SET scan_status='blocked' WHERE id='uploaded'");assert.equal(get("SELECT scan_status FROM draft_attachments WHERE id='uploaded'").scan_status,'blocked');});
 run("INSERT INTO draft_attachment_uploads(id,mailbox_id,draft_id,expected_version,filename,content_type,total_bytes,created_at,expires_at) VALUES('upload-session','a','attachment-draft',1,'report.bin','application/octet-stream',10,?,?)",now,now+3600000);
 reject('上传进度不能超过声明大小',()=>run("UPDATE draft_attachment_uploads SET received_bytes=11 WHERE id='upload-session'"));
 reject('未附加文件不能标为完成上传',()=>run("UPDATE draft_attachment_uploads SET state='completed',received_bytes=10 WHERE id='upload-session'"));
 run("INSERT INTO draft_attachment_upload_parts(upload_id,mailbox_id,offset_bytes,size_bytes,object_key,sha256,created_at) VALUES('upload-session','a',0,10,'upload/chunk',?,?)",hash,now);
 reject('已保存的上传分块不能改写',()=>run("UPDATE draft_attachment_upload_parts SET sha256=? WHERE upload_id='upload-session'",'b'.repeat(64)));
 reject('上传分块不能跨邮箱引用会话',()=>run("INSERT INTO draft_attachment_upload_parts(upload_id,mailbox_id,offset_bytes,size_bytes,object_key,sha256,created_at) VALUES('upload-session','b',10,1,'upload/cross',?,?)",hash,now));
 reject('JSON元数据格式必须有效',()=>run("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,payload_json,available_at,created_at) VALUES('json','a','parse_email','json','invalid',?,?)",now,now));
 reject('运行任务必须有完整租约',()=>run("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,state,available_at,created_at) VALUES('running','a','parse_email','running','running',?,?)",now,now));
 reject('非运行任务不能遗留半个租约',()=>run("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,lease_token,available_at,created_at) VALUES('partial','a','parse_email','partial','lease',?,?)",now,now));
 run("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,available_at,created_at) VALUES('claim','a','parse_email','claim',?,?)",now,now);
 const claim=()=>run("UPDATE jobs SET state='running',lease_token='lease-new',lease_until=?,attempts=attempts+1 WHERE id='claim' AND state='pending'",now+60000);
 test('任务条件领取只有一次成功',()=>{assert.equal(claim().changes,1);assert.equal(claim().changes,0);});
 test('过期Worker不能ACK新租约',()=>assert.equal(run("UPDATE jobs SET state='done',lease_token=NULL,lease_until=NULL WHERE id='claim' AND lease_token='lease-old'").changes,0));
 run("UPDATE jobs SET state='done',lease_token=NULL,lease_until=NULL WHERE id='claim' AND lease_token='lease-new'");
 run("INSERT INTO daily_send_counters(id,mailbox_id,day_utc,limit_snapshot) VALUES('counter-a','a','2026-11-13',5)");
 run("INSERT INTO daily_send_counters(id,mailbox_id,day_utc,limit_snapshot) VALUES('counter-b','b','2026-11-13',5)");
 const reserve=(id,op,units=1,box='a',counter='counter-a')=>run("INSERT INTO send_reservations(id,mailbox_id,counter_id,operation_id,units,created_at) VALUES(?,?,?,?,?,?)",id,box,counter,op,units,now);
 reserve('r1','op1',2);
 test('预留trigger原子增加reserved',()=>assert.equal(get("SELECT reserved_units FROM daily_send_counters WHERE id='counter-a'").reserved_units,2));
 reject('重复预留不重复扣额度',()=>reserve('r1-copy','op1',2));
 test('唯一约束失败回滚trigger计数变化',()=>assert.equal(get("SELECT reserved_units FROM daily_send_counters WHERE id='counter-a'").reserved_units,2));
 reject('超额预留明确抛错而非零行继续',()=>reserve('too-many','too-many',4));
 reject('预留不能使用另一邮箱的counter',()=>reserve('wrong-counter','wrong-counter',1,'a','counter-b'));
 reject('多语句工作流失败整体回滚',()=>atomic(()=>{
  run("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,available_at,created_at) VALUES('rollback-job','a','send_email','rollback',?,?)",now,now);
  reserve('rollback-r','rollback-op',4);
 }));
 test('失败批次不留下发送任务或额度',()=>{
  assert.equal(get("SELECT count(*) n FROM jobs WHERE id='rollback-job'").n,0);
  assert.equal(get("SELECT reserved_units FROM daily_send_counters WHERE id='counter-a'").reserved_units,2);
 });
 run("UPDATE send_reservations SET state='committed',settled_at=? WHERE id='r1'",now);
 test('提交预留只结算一次',()=>{
  run("UPDATE send_reservations SET state='committed' WHERE id='r1'");
  assert.equal(get("SELECT used_units FROM daily_send_counters WHERE id='counter-a'").used_units,2);
  assert.equal(get("SELECT reserved_units FROM daily_send_counters WHERE id='counter-a'").reserved_units,0);
 });
 reject('已提交额度不能再释放',()=>run("UPDATE send_reservations SET state='released' WHERE id='r1'"));
 reserve('unknown-r','unknown-op',1);
 run("UPDATE send_reservations SET state='reconciling' WHERE id='unknown-r'");
 test('unknown对账状态继续持有预留',()=>assert.equal(get("SELECT reserved_units FROM daily_send_counters WHERE id='counter-a'").reserved_units,1));
 run("UPDATE send_reservations SET state='released' WHERE id='unknown-r'");
 reserve('out-r','out-a',1);
 const outbound=(id,box='a',frozen='frozen-a',reservation='out-r')=>run("INSERT INTO outbound_messages(id,mailbox_id,sender_address_id,requested_by_token_id,frozen_object_id,reservation_id,request_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",id,box,'addr-a','token-a',frozen,reservation,hash,now,now);
 reject('发送命令必须匹配预留operation',()=>outbound('other-id'));
 object('pending-out','a','outbound','pending');
 reject('发送快照必须持久化ready',()=>outbound('out-a','a','pending-out'));
 outbound('out-a');
 reject('冻结发送快照不能修改',()=>run("UPDATE outbound_messages SET frozen_object_id='pending-out' WHERE id='out-a'"));
 reject('收件人记录不能跨邮箱关联命令',()=>run("INSERT INTO outbound_recipients(id,mailbox_id,outbound_id,kind,address) VALUES('rcpt','b','out-a','to','x@example.net')"));
 run("INSERT INTO outbound_recipients(id,mailbox_id,outbound_id,kind,address) VALUES('rcpt','a','out-a','bcc','x@example.net')");
 reject('已冻结收件人不能改地址',()=>run("UPDATE outbound_recipients SET address='y@example.net' WHERE id='rcpt'"));
 const idem=(id,box='a',principal='token:token-a')=>run("INSERT INTO idempotency_keys(id,mailbox_id,principal_key,operation,key,request_sha256,created_at,expires_at) VALUES(?,?,?,'send','request-key',?,?,?)",id,box,principal,hash,now,now+1000);
 idem('i1');
 reject('同邮箱同主体同操作幂等键唯一',()=>idem('i2'));
 idem('i3','b','token:token-b');
 test('不同邮箱幂等键不冲突',()=>assert.equal(get('SELECT count(*) n FROM idempotency_keys').n,2));
 run("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('event-a','a','app','stable','received','{}',?,?)",now,now);
 reject('服务商稳定event ID重复被拒绝',()=>run("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('duplicate','a','app','stable','received','{}',?,?)",now,now));
 run("INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at) VALUES('hook-b','b','https://example.net/hook','[]',?,?)",JSON.stringify({kid:'test',nonce:'fixture',ciphertext:'fixture'}),now);
 reject('Webhook不能把其他邮箱事件投到本邮箱endpoint',()=>run("INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,available_at,signed_secret_version,signing_secret_ciphertext,created_at) VALUES('delivery','b','hook-b','event-a',?,1,?,?)",now,'{}',now));
 run("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('event-b','b','app','stable-b','received','{}',?,?)",now,now);
 run("INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,available_at,signed_secret_version,signing_secret_ciphertext,created_at) VALUES('delivery-b','b','hook-b','event-b',?,1,?,?)",now,JSON.stringify({kid:'old',ciphertext:'fixture'}),now);
 run("UPDATE webhook_endpoints SET secret_version=2,signing_secret_ciphertext=? WHERE id='hook-b'",JSON.stringify({kid:'new',ciphertext:'fixture2'}));
 test('Webhook轮换不改变在途签名版本快照',()=>{
  assert.equal(get("SELECT signed_secret_version FROM webhook_deliveries WHERE id='delivery-b'").signed_secret_version,1);
  assert.equal(JSON.parse(get("SELECT signing_secret_ciphertext FROM webhook_deliveries WHERE id='delivery-b'").signing_secret_ciphertext).kid,'old');
 });
 reject('Webhook目标地址不可修改',()=>run("UPDATE webhook_endpoints SET url='https://other.example.net/' WHERE id='hook-b'"));
 reject('Webhook冻结正文不可修改',()=>run("UPDATE webhook_deliveries SET payload_json='{\"changed\":true}' WHERE id='delivery-b'"));
 reject('持久邮件事件不可改写正文',()=>run("UPDATE events SET payload_json='{\"changed\":true}' WHERE id='event-b'"));
 reject('Webhook尝试不能引用其他邮箱投递',()=>run("INSERT INTO webhook_delivery_attempts(id,mailbox_id,delivery_id,attempt_no,lease_token,started_at) VALUES('cross-attempt','a','delivery-b',1,'lease',?)",now));
 run("INSERT INTO webhook_delivery_attempts(id,mailbox_id,delivery_id,attempt_no,lease_token,started_at) VALUES('attempt-b','b','delivery-b',1,'lease',?)",now);
 reject('Webhook相同投递尝试号唯一',()=>run("INSERT INTO webhook_delivery_attempts(id,mailbox_id,delivery_id,attempt_no,lease_token,started_at) VALUES('repeat-attempt','b','delivery-b',1,'other-lease',?)",now));
 reject('Webhook重放预算受限',()=>run("UPDATE webhook_deliveries SET attempt_budget=81 WHERE id='delivery-b'"));
 reject('Token审计不能丢失邮箱归属',()=>run("INSERT INTO audit_events(id,actor_kind,token_id,action,outcome,request_id,occurred_at) VALUES('audit','token','token-a','read','success','request',?)",now));
 run("INSERT INTO oauth_clients(client_id,kind,client_name,redirect_uris_json,scope,created_at) VALUES('client-a','dynamic','Test MCP','[\"https://client.example/callback\"]','mail:read',?)",now);
 reject('OAuth客户端回调列表必须为JSON数组',()=>run("INSERT INTO oauth_clients(client_id,kind,client_name,redirect_uris_json,scope,created_at) VALUES('client-invalid','dynamic','Test MCP','{}','mail:read',?)",now));
 const grant=(id,box='a',principal='token-a')=>run("INSERT INTO oauth_grants(id,client_id,mailbox_id,mailbox_token_id,resource,scope,created_at,expires_at) VALUES(?,'client-a',?,?,'https://api.example/mcp','mail:read',?,?)",id,box,principal,now,now+3600000);
 reject('OAuth授权不能绑定其他邮箱Token',()=>grant('grant-cross','a','token-b'));
 grant('grant-a'); grant('grant-b','b','token-b');
 reject('OAuth授权主体不能被多个授权共享',()=>grant('grant-duplicate'));
 reject('OAuth授权不能改变resource或扩大scope',()=>run("UPDATE oauth_grants SET resource='https://other.example/mcp',scope='mail:read mail:draft' WHERE id='grant-a'"));
 reject('OAuth授权有效期必须晚于创建时间',()=>run("INSERT INTO oauth_grants(id,client_id,mailbox_id,mailbox_token_id,resource,scope,created_at,expires_at) VALUES('grant-expired','client-a','a','token-a','https://api.example/mcp','mail:read',?,?)",now,now));
 reject('OAuth同意表单只接受有效CSRF摘要',()=>run("INSERT INTO oauth_authorization_requests(id,client_id,redirect_uri,resource,requested_scope,code_challenge,owner_email,csrf_sha256,created_at,expires_at) VALUES('request-invalid','client-a','https://client.example/callback','https://api.example/mcp','mail:read','challenge','owner@example.com','plaintext',?,?)",now,now+600000));
 run("INSERT INTO oauth_authorization_codes(id,grant_id,secret_sha256,redirect_uri,code_challenge,created_at,expires_at) VALUES('code-a','grant-a',?,'https://client.example/callback','challenge',?,?)",hash,now,now+120000);
 reject('OAuth授权码不能改变回调或PKCE绑定',()=>run("UPDATE oauth_authorization_codes SET redirect_uri='https://attacker.example/callback',code_challenge='changed' WHERE id='code-a'"));
 test('OAuth授权码条件消费只有一个请求成功',()=>{
  const consume=()=>run("UPDATE oauth_authorization_codes SET used_at=? WHERE id='code-a' AND used_at IS NULL",now+1);
  assert.equal(consume().changes,1);assert.equal(consume().changes,0);
 });
 reject('OAuth访问令牌不能保存明文secret',()=>run("INSERT INTO oauth_access_tokens(id,grant_id,secret_sha256,scope,created_at,expires_at) VALUES('access-plaintext','grant-a','amo_plaintext','mail:read',?,?)",now,now+600000));
 run("INSERT INTO oauth_access_tokens(id,grant_id,secret_sha256,scope,created_at,expires_at) VALUES('access-a','grant-a',?,'mail:read',?,?)",hash,now,now+600000);
 reject('OAuth访问令牌摘要与有效期不可重写',()=>run("UPDATE oauth_access_tokens SET secret_sha256=?,expires_at=? WHERE id='access-a'",'f'.repeat(64),now+7200000));
 const refresh=(id,grantId,digest)=>run("INSERT INTO oauth_refresh_tokens(id,grant_id,secret_sha256,scope,created_at,expires_at) VALUES(?,?,?,'mail:read',?,?)",id,grantId,digest,now,now+3600000);
 refresh('refresh-a','grant-a',hash);refresh('refresh-a2','grant-a','b'.repeat(64));refresh('refresh-b','grant-b','c'.repeat(64));
 reject('OAuth刷新令牌不能轮换到其他授权族',()=>run("UPDATE oauth_refresh_tokens SET used_at=?,replaced_by_id='refresh-b' WHERE id='refresh-a'",now+1));
 test('OAuth刷新令牌支持同族原子轮换并保留旧摘要',()=>{
  const rotate=()=>run("UPDATE oauth_refresh_tokens SET used_at=?,replaced_by_id='refresh-a2' WHERE id='refresh-a' AND used_at IS NULL",now+1);
  assert.equal(rotate().changes,1);assert.equal(rotate().changes,0);
  assert.equal(get("SELECT secret_sha256 FROM oauth_refresh_tokens WHERE id='refresh-a'").secret_sha256,hash);
 });
 const deliveryReceipt=(id,eventId)=>run(`INSERT INTO email_delivery_events(id,account_id,event_id,zone_id,subscription_id,domain,provider_message_id,sender,recipient,event_type,event_at,terminal,canonical_sha256,received_at,expires_at,next_attempt_at)
  VALUES(?,'account',?,'zone','subscription','example.com','provider-message','sender@example.com','recipient@example.net','delivered',?,1,?,?,?,?)`,id,eventId,now,hash,now,now+86400000,now);
 deliveryReceipt('receipt-a','event-a');
 reject('投递事件按账户和event ID唯一',()=>deliveryReceipt('receipt-duplicate','event-a'));
 reject('投递事件不能改写提供商身份与内容摘要',()=>run("UPDATE email_delivery_events SET provider_message_id='forged' WHERE id='receipt-a'"));
 reject('投递事件不能关联其他邮箱的发送记录',()=>run("UPDATE email_delivery_events SET mailbox_id='b',outbound_id='out-a' WHERE id='receipt-a'"));
 reject('未关联投递事件不能成为applied',()=>run("UPDATE email_delivery_events SET state='applied',applied_at=? WHERE id='receipt-a'",now));
 run("UPDATE email_delivery_events SET state='ignored',ignore_reason='unmatched_expired',applied_at=? WHERE id='receipt-a'",now);
 reject('已经终结的事件不能重新待处理',()=>run("UPDATE email_delivery_events SET state='pending',applied_at=NULL WHERE id='receipt-a'"));
 reject('投递补账次数受限',()=>run("UPDATE email_delivery_events SET reconcile_attempts=65 WHERE id='receipt-a'"));
 const suppression=(id,box='a',address='blocked@example.net')=>run(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at)
  VALUES(?,?,?,'complaint',?,'provider-event',?,?)`,id,box,address,now,now,now);
 suppression('suppression-a');suppression('suppression-b','b');
 reject('抑制地址在邮箱内唯一',()=>suppression('suppression-duplicate'));
 reject('抑制记录不能迁移邮箱或改写地址',()=>run("UPDATE recipient_suppressions SET mailbox_id='b',version=2 WHERE id='suppression-a'"));
 reject('抑制更新必须递增版本',()=>run("UPDATE recipient_suppressions SET status='released',released_at=? WHERE id='suppression-a'",now));
 reject('投诉抑制不能被退信降级',()=>run("UPDATE recipient_suppressions SET reason='hard_bounce',version=2 WHERE id='suppression-a'"));
 run("UPDATE recipient_suppressions SET status='released',released_at=?,release_watermark=?,version=2 WHERE id='suppression-a'",now,now);
 reject('解除水位不能回退',()=>run("UPDATE recipient_suppressions SET release_watermark=0,version=3 WHERE id='suppression-a'"));
 reject('投递事件永久退信证据不可事后改写',()=>run("UPDATE email_delivery_events SET bounce_type='hard' WHERE id='receipt-a'"));
 reject('投递证据版本不可事后升级',()=>run("UPDATE email_delivery_events SET evidence_version=1 WHERE id='receipt-a'"));
 reject('服务端抑制缓存拒绝其他发信域作用域',()=>run(`INSERT INTO cloudflare_suppression_cache(account_id,configured_domain,remote_id,address,scope_type,scope_value,reason,read_only,version_hash,provider_created_at,seen_at,updated_at,last_sync_id)
  VALUES('account','example.com','remote','blocked@example.net','sending_domain','other.example.com','policy',1,?,1,1,1,'sync')`,hash));
 reject('服务端抑制只读字段必须为布尔值',()=>run(`INSERT INTO cloudflare_suppression_cache(account_id,configured_domain,remote_id,address,scope_type,scope_value,reason,read_only,version_hash,provider_created_at,seen_at,updated_at,last_sync_id)
  VALUES('account','example.com','remote','blocked@example.net','account','','policy',2,?,1,1,1,'sync')`,hash));
 reject('服务端同步租约不能保存半个租约',()=>run("INSERT INTO cloudflare_suppression_sync(account_id,domain,lease_token) VALUES('account','example.com','half-lease')"));
 const providerOperation=id=>run(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,release_local,local_id,local_version,state,remote_status,local_status,created_at,updated_at)
  VALUES(?,?,'account','example.com','a','remote','blocked@example.net','account','',?,1,'suppression-a',2,'unknown','unknown','pending',?,?)`,id,hash,hash,now,now);
 providerOperation('provider-operation');
 reject('未确定的服务端解除阻止第二个同记录操作',()=>providerOperation('provider-operation-duplicate'));
 reject('服务端解除命令和本地版本不可改写',()=>run("UPDATE cloudflare_suppression_operations SET local_version=3 WHERE id='provider-operation'"));
 reject('服务端解除命令不能联动其他邮箱本地记录',()=>run(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,release_local,local_id,local_version,state,remote_status,local_status,created_at,updated_at)
  VALUES('provider-cross',?,'account','example.com','b','other-remote','blocked@example.net','account','',?,1,'suppression-a',2,'unknown','unknown','pending',?,?)`,hash,hash,now,now));
 const journalId=get("SELECT id FROM cloudflare_suppression_history_events WHERE resource_id='provider-operation'").id;
 reject('服务端执行时间线不能改写',()=>run("UPDATE cloudflare_suppression_history_events SET error_code='forged' WHERE id=?",journalId));
 reject('服务端执行时间线不能删除',()=>run('DELETE FROM cloudflare_suppression_history_events WHERE id=?',journalId));
 const syncRun=(id,parent=null,account='account')=>run(`INSERT INTO cloudflare_suppression_sync_runs(id,request_hash,account_id,domain,mailbox_id,source,retry_of,state,started_at)
  VALUES(?,?,?,'example.com','a','owner',?,'running',?)`,id,hash,account,parent,now);
 syncRun('sync-history');run("UPDATE cloudflare_suppression_sync_runs SET state='failed',error_code='cloudflare_api_timeout',completed_at=? WHERE id='sync-history'",now+1);
 reject('已经完成的同步执行不能改写',()=>run("UPDATE cloudflare_suppression_sync_runs SET state='succeeded' WHERE id='sync-history'"));
 syncRun('sync-retry','sync-history');
 reject('同步执行重试父记录不能改写',()=>run("UPDATE cloudflare_suppression_sync_runs SET retry_of=NULL WHERE id='sync-retry'"));
 reject('同步重试不能引用其他账户的父记录',()=>syncRun('sync-cross','sync-history','other-account'));
 reject('未知结果对账不能关联其他邮箱的解除操作',()=>run(`INSERT INTO cloudflare_suppression_reconciliations(id,request_hash,operation_id,account_id,domain,mailbox_id,state,started_at)
  VALUES('reconcile-cross',?,'provider-operation','account','example.com','b','running',?)`,hash,now));
 run(`INSERT INTO cloudflare_suppression_reconciliations(id,request_hash,operation_id,account_id,domain,mailbox_id,state,started_at)
  VALUES('reconcile-history',?,'provider-operation','account','example.com','a','running',?)`,hash,now);
 run("UPDATE cloudflare_suppression_reconciliations SET state='failed',error_code='cloudflare_api_timeout',completed_at=? WHERE id='reconcile-history'",now+1);
 reject('已经完成的对账执行不能改写',()=>run("UPDATE cloudflare_suppression_reconciliations SET state='succeeded' WHERE id='reconcile-history'"));
 reject('解除操作重试来源不能改写',()=>run("UPDATE cloudflare_suppression_operations SET retry_of='provider-operation' WHERE id='provider-operation'"));
 reject('告警游标不能使用不完整的账户域标识',()=>run("INSERT INTO cloudflare_suppression_alert_cursors VALUES('account','',0)"));
 reject('告警游标不能倒退到负数',()=>run("UPDATE cloudflare_suppression_alert_cursors SET last_rowid=-1 WHERE account_id=''"));
 const alert=(id,{kind='sync',box='a',global=0,status='open',outcome='failed',group=id,journal=journalId}={})=>run(`INSERT INTO cloudflare_suppression_alerts
  (id,account_id,domain,kind,group_key,mailbox_id,global_scope,status,outcome,version,generation,occurrences,first_occurred_at,last_occurred_at,source_id,last_fingerprint,last_journal_id)
  VALUES(?,'account','example.com',?,?,?,?,?,?,1,1,1,?,?,'sync-history',?,?)`,id,kind,group,box,global,status,outcome,now,now,hash,journal);
 alert('alert-local');alert('alert-global',{box:null,global:1});
 reject('同账户域和重试分组只能有一个告警',()=>alert('alert-duplicate',{group:'alert-local'}));
 reject('全局告警不能绑定具体邮箱',()=>alert('alert-global-box',{global:1}));
 reject('解除失败不能伪装为全局告警',()=>alert('alert-global-release',{kind:'release',box:null,global:1}));
 reject('邮箱告警不能丢失邮箱归属',()=>alert('alert-missing-box',{box:null}));
 reject('告警解决状态必须匹配解决结果',()=>alert('alert-invalid-resolution',{status:'resolved'}));
 reject('告警必须引用存在的执行日志',()=>alert('alert-missing-journal',{journal:'missing-journal'}));
 reject('确认告警必须递增版本',()=>run("UPDATE cloudflare_suppression_alerts SET status='acknowledged',acknowledged_at=? WHERE id='alert-local'",now));
 reject('告警不能迁移邮箱或账户域',()=>run("UPDATE cloudflare_suppression_alerts SET mailbox_id='b',version=2 WHERE id='alert-local'"));
 run("UPDATE cloudflare_suppression_alerts SET version=2,generation=2,occurrences=2 WHERE id='alert-local'");
 reject('告警代数不能回退',()=>run("UPDATE cloudflare_suppression_alerts SET version=3,generation=1 WHERE id='alert-local'"));
 reject('告警发生次数不能回退',()=>run("UPDATE cloudflare_suppression_alerts SET version=3,occurrences=1 WHERE id='alert-local'"));
 run("INSERT INTO cloudflare_suppression_alert_occurrences(id,alert_id,journal_id,action,outcome,version,occurred_at,source_id) VALUES('alert-occurrence','alert-local',?,'failed','failed',2,?,'sync-history')",journalId,now);
 reject('同一告警日志不能重复计入时间线',()=>run("INSERT INTO cloudflare_suppression_alert_occurrences(id,alert_id,journal_id,action,outcome,version,occurred_at,source_id) VALUES('alert-repeat','alert-local',?,'failed','failed',2,?,'sync-history')",journalId,now));
 reject('告警时间线不可改写',()=>run("UPDATE cloudflare_suppression_alert_occurrences SET error_code='forged' WHERE id='alert-occurrence'"));
 reject('告警时间线不可删除',()=>run("DELETE FROM cloudflare_suppression_alert_occurrences WHERE id='alert-occurrence'"));
 test('0011升级以历史游标为屏障且不补发旧失败告警',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0011_cloudflare_suppression_alerts.sql');
   upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO cloudflare_suppression_history_events(id,account_id,domain,kind,resource_id,action,state,error_code,occurred_at) VALUES('legacy-failure','account','example.com','sync','legacy-run','sync.completed','failed','cloudflare_api_timeout',?)").run(now);
   const old=upgrade.prepare('SELECT MAX(rowid) n FROM cloudflare_suppression_history_events').get().n;upgrade.exec(migrationTexts[index]);
   assert.equal(upgrade.prepare("SELECT last_rowid FROM cloudflare_suppression_alert_cursors WHERE account_id='' AND domain=''").get().last_rowid,old);
   assert.equal(upgrade.prepare('SELECT count(*) n FROM cloudflare_suppression_alerts').get().n,0);
   assert.equal(upgrade.prepare('SELECT count(*) n FROM cloudflare_suppression_alert_occurrences').get().n,0);
  }finally{upgrade.close();}
 });
 run("INSERT INTO alert_notification_policies(mailbox_id,updated_at) VALUES('a',?)",now);
 test('通知策略的默认值保留旧版告警通知行为',()=>{
  const policy=get("SELECT * FROM alert_notification_policies WHERE mailbox_id='a'");
  assert.equal(policy.enabled,1);assert.equal(policy.recovery_enabled,1);assert.equal(policy.repeat_interval_seconds,0);assert.equal(policy.quiet_enabled,0);assert.equal(policy.time_zone,'UTC');assert.equal(policy.version,1);
 });
 reject('每个邮箱只能有一份通知策略',()=>run("INSERT INTO alert_notification_policies(mailbox_id,updated_at) VALUES('a',?)",now));
 reject('通知开关只接受布尔整数',()=>run("INSERT INTO alert_notification_policies(mailbox_id,enabled,updated_at) VALUES('b',2,?)",now));
 reject('重复通知间隔不能超过一周',()=>run("INSERT INTO alert_notification_policies(mailbox_id,repeat_interval_seconds,updated_at) VALUES('b',604801,?)",now));
 reject('静默起始时间必须是日内分钟',()=>run("INSERT INTO alert_notification_policies(mailbox_id,quiet_start_minute,updated_at) VALUES('b',1440,?)",now));
 reject('启用静默时不能用相同起止时间',()=>run("INSERT INTO alert_notification_policies(mailbox_id,quiet_enabled,quiet_start_minute,quiet_end_minute,updated_at) VALUES('b',1,0,0,?)",now));
 reject('通知时区不能是空字符串',()=>run("INSERT INTO alert_notification_policies(mailbox_id,time_zone,updated_at) VALUES('b','',?)",now));
 reject('通知策略更新必须递增版本',()=>run("UPDATE alert_notification_policies SET enabled=0,updated_at=? WHERE mailbox_id='a'",now+1));
 reject('通知策略更新时间必须单调递增',()=>run("UPDATE alert_notification_policies SET enabled=0,version=2 WHERE mailbox_id='a'"));
 test('通知策略可通过新版本原子更新',()=>{
  run("UPDATE alert_notification_policies SET enabled=0,version=2,updated_at=? WHERE mailbox_id='a'",now+1);
  assert.equal(get("SELECT enabled FROM alert_notification_policies WHERE mailbox_id='a'").enabled,0);
 });
 reject('通知策略不能迁移到其他邮箱',()=>run("UPDATE alert_notification_policies SET mailbox_id='b',version=3,updated_at=? WHERE mailbox_id='a'",now+2));
 run("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES('event-a','a','alert-local','allowed',2,?,'claim')",now);
 reject('每个通知事件只能有一个持久决策',()=>run("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES('event-a','a','alert-local','disabled',2,?,'other')",now));
 reject('通知决策不能引用其他邮箱事件',()=>run("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES('event-b','a','alert-local','allowed',0,?,'claim')",now));
 reject('通知决策只接受已定义的策略结果',()=>run("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES('event-b','b','alert-global','deliver_anyway',0,?,'claim')",now));
 reject('通知决策不可改写',()=>run("UPDATE alert_notification_decisions SET decision='disabled' WHERE event_id='event-a'"));
 reject('通知决策不可删除',()=>run("DELETE FROM alert_notification_decisions WHERE event_id='event-a'"));
 run("INSERT INTO alert_notification_state(mailbox_id,alert_id,fingerprint,last_notified_at) VALUES('a','alert-local',?,?)",hash,now);
 reject('通知限频状态不能迁移邮箱',()=>run("UPDATE alert_notification_state SET mailbox_id='b' WHERE mailbox_id='a'"));
 reject('通知限频时间不能是负数',()=>run("UPDATE alert_notification_state SET last_notified_at=-1 WHERE mailbox_id='a'"));
 test('恢复可以重置通知限频而保留告警身份',()=>{
  run("UPDATE alert_notification_state SET last_notified_at=NULL WHERE mailbox_id='a'");
  assert.equal(get("SELECT last_notified_at FROM alert_notification_state WHERE mailbox_id='a'").last_notified_at,null);
 });
 test('0012升级保留旧事件且不创建通知决策或策略',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0012_alert_notification_policies.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('legacy-mailbox','Legacy',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('legacy-event','legacy-mailbox','app','legacy','message.received','{}',?,?)").run(now,now);
   upgrade.exec(migrationTexts[index]);assert.equal(upgrade.prepare('SELECT count(*) n FROM events').get().n,1);
   for(const table of ['alert_notification_policies','alert_notification_decisions','alert_notification_state'])assert.equal(upgrade.prepare('SELECT count(*) n FROM '+table).get().n,0);
  }finally{upgrade.close();}
 });
 test('通知决策原因索引存在且列顺序匹配邮箱筛选和倒序分页',()=>{
  assert.deepEqual(db.prepare('PRAGMA index_info(alert_notification_decision_reason)').all().map(column=>column.name),['mailbox_id','decision','decided_at','event_id']);
  assert.equal(get("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='alert_notification_decision_reason'").tbl_name,'alert_notification_decisions');
 });
 test('邮件事件投递索引绑定当前邮箱和事件',()=>{
  assert.deepEqual(db.prepare('PRAGMA index_info(webhook_event_deliveries)').all().map(column=>column.name),['mailbox_id','event_id']);
  assert.equal(get("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='webhook_event_deliveries'").tbl_name,'webhook_deliveries');
 });
 test('按原因及时间分页使用通知决策专用索引而不创建临时排序表',()=>{
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM alert_notification_decisions WHERE mailbox_id=? AND decision=? AND decided_at>=? AND decided_at<? ORDER BY decided_at DESC,event_id DESC LIMIT 20").all('a','allowed',0,now+1).map(row=>row.detail).join('\n');
  assert.ok(plan.includes('alert_notification_decision_reason'),plan);assert.ok(!plan.includes('TEMP B-TREE'),plan);
 });
 test('按邮箱事件汇总投递使用专用索引',()=>{
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT state,attempts FROM webhook_deliveries WHERE mailbox_id=? AND event_id=?').all('a','event-a').map(row=>row.detail).join('\n');
  assert.ok(plan.includes('webhook_event_deliveries'),plan);
 });
 test('0013仅新增查询索引并保留已有通知决策与策略',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0013_alert_notification_decision_indexes.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('legacy-mailbox','Legacy',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('legacy-event','legacy-mailbox','app','legacy','cloudflare.suppression.alert.created','{}',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO alert_notification_policies(mailbox_id,updated_at) VALUES('legacy-mailbox',?)").run(now);
   upgrade.prepare("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES('legacy-event','legacy-mailbox','legacy-alert','quiet_hours',1,?,'private-claim')").run(now);
   upgrade.exec(migrationTexts[index]);assert.equal(upgrade.prepare('SELECT count(*) n FROM alert_notification_decisions').get().n,1);
   assert.equal(upgrade.prepare('SELECT decision FROM alert_notification_decisions').get().decision,'quiet_hours');
   assert.equal(upgrade.prepare('SELECT version FROM alert_notification_policies').get().version,1);assert.equal(upgrade.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{upgrade.close();}
 });
 const asyncJobSql=`INSERT INTO async_alert_notification_exports(id,mailbox_id,client_request_id,request_hash,format,filter_decision,filter_event_type,from_ms,to_ms,
  decision_watermark,total_decisions,summary_json,created_at,updated_at,expires_at,available_at,cleanup_due_at) VALUES(?,?,?,?,'json','all','all',?,?,0,?,'{}',?,?,?,?,?)`;
 const insertAsyncJob=(id,mailbox='a',total=2)=>run(asyncJobSql,id,mailbox,id,hash,now-1,now+1,total,now,now,now+86400000,now,now+86400000);
 insertAsyncJob('async-job-a');
 test('异步导出默认排队且进度为空，不虚构现有通知任务',()=>{
  const job=get("SELECT state,version,processed_decisions,processed_deliveries,chunk_count,body_bytes,lease_token FROM async_alert_notification_exports WHERE id='async-job-a'");
  assert.deepEqual({...job},{state:'queued',version:1,processed_decisions:0,processed_deliveries:0,chunk_count:0,body_bytes:0,lease_token:null});
 });
 reject('同一邮箱的异步导出请求ID唯一',()=>run(asyncJobSql,'async-duplicate','a','async-job-a',hash,now-1,now+1,2,now,now,now+86400000,now,now));
 reject('异步导出决策总数不能超过十万',()=>insertAsyncJob('async-too-large','a',100001));
 reject('异步导出不能保存跨越31天的筛选窗口',()=>run(asyncJobSql,'async-window','a','async-window',hash,0,32*86400000,2,now,now,now+86400000,now,now));
 reject('异步导出运行态必须有租约',()=>run("UPDATE async_alert_notification_exports SET state='running',version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出更新必须递增版本',()=>run("UPDATE async_alert_notification_exports SET available_at=available_at+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出筛选与水位不可改写',()=>run("UPDATE async_alert_notification_exports SET decision_watermark=1,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出有效期不可延长',()=>run("UPDATE async_alert_notification_exports SET expires_at=expires_at+1,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 run("UPDATE async_alert_notification_exports SET state='running',lease_token='lease-a',lease_until=?,started_at=?,attempts=1,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'",now+120000,now);
 run("UPDATE async_alert_notification_exports SET processed_decisions=1,processed_deliveries=2,chunk_count=1,body_bytes=16,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'");
 reject('异步导出进度不能倒退',()=>run("UPDATE async_alert_notification_exports SET processed_decisions=0,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出进度不能超过任务总数',()=>run("UPDATE async_alert_notification_exports SET processed_decisions=3,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出投递数不能超过百万',()=>run("UPDATE async_alert_notification_exports SET processed_deliveries=1000001,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出正文预算不能超过256MiB',()=>run("UPDATE async_alert_notification_exports SET body_bytes=268435457,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'"));
 reject('异步导出分片不能跨邮箱引用任务',()=>run("INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at) VALUES('async-job-a','b',1,'exports/b/part',16,?,?)",hash,now));
 run("INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at) VALUES('async-job-a','a',1,'exports/a/part',16,?,?)",hash,now);
 reject('异步导出分片顺序不能重复发布',()=>run("INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at) VALUES('async-job-a','a',1,'exports/a/another',16,?,?)",hash,now));
 reject('异步导出分片必须有SHA256校验和',()=>run("INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at) VALUES('async-job-a','a',2,'exports/a/bad',16,'invalid',?)",now));
 reject('异步导出分片清单不可修改',()=>run("UPDATE async_alert_notification_export_chunks SET object_key='different' WHERE job_id='async-job-a'"));
 reject('异步导出分片清单保留以核对过期迟到写入',()=>run("DELETE FROM async_alert_notification_export_chunks WHERE job_id='async-job-a'"));
 run("UPDATE async_alert_notification_exports SET state='cancelled',lease_token=NULL,lease_until=NULL,completed_at=?,cleanup_due_at=?,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'",now,now);
 reject('已取消导出不能恢复为运行态',()=>run("UPDATE async_alert_notification_exports SET state='running',lease_token='other',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a'",now+120000));
 test('已取消导出的旧租约不能发布进度',()=>assert.equal(run("UPDATE async_alert_notification_exports SET processed_decisions=2,version=version+1,updated_at=updated_at+1 WHERE id='async-job-a' AND state='running' AND lease_token='lease-a'").changes,0));
 reject('异步导出清理墓碑不能删除',()=>run("DELETE FROM async_alert_notification_exports WHERE id='async-job-a'"));
 test('0014升级保留已有通知决策且不伪造异步任务或分片',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0014_async_alert_notification_exports.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('legacy-mailbox','Legacy',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('legacy-event','legacy-mailbox','app','legacy','cloudflare.suppression.alert.created','{}',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES('legacy-event','legacy-mailbox','legacy-alert','quiet_hours',1,?,'private-claim')").run(now);
   upgrade.exec(migrationTexts[index]);assert.equal(upgrade.prepare('SELECT count(*) n FROM alert_notification_decisions').get().n,1);
   for(const table of ['async_alert_notification_exports','async_alert_notification_export_chunks'])assert.equal(upgrade.prepare('SELECT count(*) n FROM '+table).get().n,0);
   assert.equal(upgrade.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{upgrade.close();}
 });
 insertAsyncJob('notice-success','a',0);
 run("UPDATE async_alert_notification_exports SET state='running',lease_token='notice-lease',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id='notice-success'",now+120000);
 test('导出成功与通知快照在同一事务写入',()=>{
  run("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='notice-success'",now);
  assert.deepEqual({...get("SELECT outcome,format,version,notification_decision FROM async_export_notifications WHERE job_id='notice-success'")},{outcome:'succeeded',format:'json',version:1,notification_decision:null});
 });
 test('已完成任务的清理更新不重复生成提醒',()=>{
  run("UPDATE async_alert_notification_exports SET cleanup_due_at=cleanup_due_at+1,version=version+1,updated_at=updated_at+1 WHERE id='notice-success'");
  assert.equal(get("SELECT count(*) n FROM async_export_notifications WHERE job_id='notice-success'").n,1);
 });
 reject('导出通知不可篡改终态快照',()=>run("UPDATE async_export_notifications SET body_bytes=1 WHERE job_id='notice-success'"));
 reject('通知确认必须递增独立版本',()=>run("UPDATE async_export_notifications SET acknowledged_at=? WHERE job_id='notice-success'",now));
 run("UPDATE async_export_notifications SET acknowledged_at=?,version=version+1 WHERE job_id='notice-success'",now);
 reject('已确认通知不能恢复为未读',()=>run("UPDATE async_export_notifications SET acknowledged_at=NULL,version=version+1 WHERE job_id='notice-success'"));
 reject('导出通知不能删除',()=>run("DELETE FROM async_export_notifications WHERE job_id='notice-success'"));
 reject('导出通知投影必须同时提供事件和时间',()=>run("UPDATE async_export_notifications SET projected_at=? WHERE job_id='notice-success'",now));
 run("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('notice-projection','a','app','notice-source','alert_notification.export.succeeded','{}',?,?)",now,now);
 run("UPDATE async_export_notifications SET event_id='notice-projection',projected_at=? WHERE job_id='notice-success'",now);
 test('投影更新不改变Owner确认版本',()=>assert.equal(get("SELECT version FROM async_export_notifications WHERE job_id='notice-success'").version,2));
 reject('导出通知投影收据不可改写',()=>run("UPDATE async_export_notifications SET projected_at=projected_at+1 WHERE job_id='notice-success'"));
 reject('导出通知准入决定需要完整策略收据',()=>run("UPDATE async_export_notifications SET notification_decision='allowed' WHERE job_id='notice-success'"));
 run("UPDATE async_export_notifications SET notification_decision='allowed',policy_version=0,decided_at=?,claim_token='notice-claim' WHERE job_id='notice-success'",now);
 reject('导出通知准入决定不可重新评估',()=>run("UPDATE async_export_notifications SET notification_decision='disabled' WHERE job_id='notice-success'"));
 test('导出文件过期后仍保留通知和确认',()=>{
  run("UPDATE async_alert_notification_exports SET state='expired',version=version+1,updated_at=updated_at+1 WHERE id='notice-success'");
  assert.equal(get("SELECT acknowledged_at FROM async_export_notifications WHERE job_id='notice-success'").acknowledged_at,now);
 });
 insertAsyncJob('notice-failed','a',0);
 run("UPDATE async_alert_notification_exports SET state='running',lease_token='failure-lease',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id='notice-failed'",now+120000);
 run("UPDATE async_alert_notification_exports SET state='failed',lease_token=NULL,lease_until=NULL,error_code='PRIVATE_PROVIDER_RESPONSE',completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='notice-failed'",now);
 test('终态失败通知仅记录安全错误码',()=>assert.equal(get("SELECT error_code FROM async_export_notifications WHERE job_id='notice-failed'").error_code,'async_export_failed'));
 reject('通知任务不能跨邮箱引用',()=>run("INSERT INTO async_export_notifications(job_id,mailbox_id,outcome,format,total_decisions,processed_decisions,processed_deliveries,body_bytes,completed_at,expires_at,created_at) VALUES('async-job-a','b','failed','json',0,0,0,0,?,?,?)",now,now+86400000,now));
 test('取消任务不产生完成或失败提醒',()=>assert.equal(get("SELECT count(*) n FROM async_export_notifications WHERE job_id='async-job-a'").n,0));
 run("INSERT INTO async_export_notification_state(mailbox_id,fingerprint,last_notified_at) VALUES('a','same-export-fingerprint',?)",now);
 reject('导出通知限频时钟不能倒退',()=>run("UPDATE async_export_notification_state SET last_notified_at=last_notified_at-1 WHERE mailbox_id='a'"));
 reject('导出通知限频状态不能跨不存在邮箱',()=>run("INSERT INTO async_export_notification_state(mailbox_id,fingerprint,last_notified_at) VALUES('missing-mailbox','x',?)",now));
 test('终态事务回滚同时撤销通知',()=>{
  insertAsyncJob('notice-rollback','a',0);
  run("UPDATE async_alert_notification_exports SET state='running',lease_token='rollback-lease',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id='notice-rollback'",now+120000);
  assert.throws(()=>atomic(()=>{run("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=updated_at+1 WHERE id='notice-rollback'");throw Error('rollback');}));
  assert.equal(get("SELECT count(*) n FROM async_export_notifications WHERE job_id='notice-rollback'").n,0);
  assert.equal(get("SELECT state FROM async_alert_notification_exports WHERE id='notice-rollback'").state,'running');
 });
 test('0015升级不补发旧终态，已有排队任务完成时生成通知',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0015_async_export_notifications.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('legacy','Legacy',?,?)").run(now,now);
   const insert=upgrade.prepare(`INSERT INTO async_alert_notification_exports(id,mailbox_id,client_request_id,request_hash,format,filter_decision,filter_event_type,from_ms,to_ms,decision_watermark,total_decisions,summary_json,state,created_at,updated_at,expires_at,available_at,cleanup_due_at) VALUES(?,'legacy',?,?,'json','all','all',0,1,0,0,'{}',?,?,?,?,?,?)`);
   insert.run('old-done','old-done',hash,'succeeded',now,now,now+86400000,now,now+86400000);insert.run('old-queued','old-queued',hash,'queued',now,now,now+86400000,now,now+86400000);
   upgrade.exec(migrationTexts[index]);assert.equal(upgrade.prepare('SELECT count(*) n FROM async_export_notifications').get().n,0);
   upgrade.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='legacy-lease',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id='old-queued'").run(now+120000);
   upgrade.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=updated_at+1 WHERE id='old-queued'").run();
   assert.equal(upgrade.prepare('SELECT count(*) n FROM async_export_notifications').get().n,1);
  }finally{upgrade.close();}
 });
 test('按邮箱及投递读取手动重试历史使用资源索引且不建立临时排序表',()=>{
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id,metadata_json,occurred_at FROM audit_events WHERE mailbox_id=? AND resource_id=? AND action='webhook.delivery_retried' ORDER BY occurred_at DESC,id DESC LIMIT 10").all('a','delivery');
  assert.ok(plan.some(row=>row.detail.includes('audit_resource_history')));assert.ok(!plan.some(row=>row.detail.includes('TEMP B-TREE')));
 });
 test('0016索引升级保留已有审计及51张表且不创建重试',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0016_export_notification_delivery_history.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('history-mailbox','History',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) VALUES('old-retry','history-mailbox','owner','webhook.delivery_retried','old-delivery','success','fixture-request',?)").run(now);
   const before=upgrade.prepare('SELECT * FROM audit_events').all();upgrade.exec(migrationTexts[index]);assert.deepEqual(upgrade.prepare('SELECT * FROM audit_events').all(),before);
   assert.equal(upgrade.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,51);
   assert.equal(upgrade.prepare('SELECT count(*) n FROM webhook_delivery_attempts').get().n,0);
  }finally{upgrade.close();}
 });
 const batchInsert=`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items) VALUES(?,?,?,?,0,1,'all',?,?,?,?,1,1)`;
 const addBatch=(id,mailbox='a')=>run(batchInsert,id,mailbox,id,hash,now,now,now+86400000,now+600000);
 addBatch('retry-batch-a');
 test('批量重试预览初始不会提交或增加发送预算',()=>{
  const row=get("SELECT state,committed_at,processed_items FROM async_export_notification_retry_batches WHERE id='retry-batch-a'");
  assert.equal(row.state,'preview');assert.equal(row.committed_at,null);assert.equal(row.processed_items,0);
 });
 reject('同一邮箱批量预览请求标识唯一',()=>run(batchInsert,'retry-batch-duplicate','a','retry-batch-a',hash,now,now,now+86400000,now+600000));
 reject('预览候选总数不能超过1000',()=>run("INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items) VALUES('too-many','a','too-many',?,0,1,'all',?,?,?,?,1001,1)",hash,now,now,now+86400000,now+600000));
 reject('批量预览范围不能覆盖超过31天',()=>run(batchInsert.replace("0,1,'all'","0,2764800000,'all'"),'too-wide','a','too-wide',hash,now,now,now+86400000,now+600000));
 reject('预览筛选及固定总数不可改写',()=>run("UPDATE async_export_notification_retry_batches SET total_items=2,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 reject('预览有效期不可延长',()=>run("UPDATE async_export_notification_retry_batches SET preview_expires_at=preview_expires_at+1,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 reject('未经确认的预览不能进入执行队列',()=>run("UPDATE async_export_notification_retry_batches SET state='queued',version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 run("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id='commit-a',commit_expected_version=1,committed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'",now);
 reject('批量提交标识一旦设置不可改写',()=>run("UPDATE async_export_notification_retry_batches SET commit_request_id='other',version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 reject('批量进度必须等于逐类结果之和',()=>run("UPDATE async_export_notification_retry_batches SET processed_items=1,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 reject('有未知结果的任务不能宣告完成',()=>run("UPDATE async_export_notification_retry_batches SET state='completed',processed_items=1,unknown_items=1,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'",now));
 run("UPDATE async_export_notification_retry_batches SET state='running',processed_items=1,requeued_items=1,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'");
 reject('已处理进度不能倒退',()=>run("UPDATE async_export_notification_retry_batches SET processed_items=0,requeued_items=0,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 run("UPDATE async_export_notification_retry_batches SET state='completed',completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'",now);
 reject('完成的批量任务不能重新启动',()=>run("UPDATE async_export_notification_retry_batches SET state='running',version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 reject('批量历史保留不允许删除',()=>run("DELETE FROM async_export_notification_retry_batches WHERE id='retry-batch-a'"));
 test('0017升级不补造批次且保留旧投递和审计表',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0017_export_notification_retry_batches.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('batch-legacy','Legacy',?,?)").run(now,now);
   upgrade.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) VALUES('old-batch-audit','batch-legacy','owner','webhook.delivery_retried','old-delivery','success','fixture',?)").run(now);
   const before=upgrade.prepare('SELECT * FROM audit_events').all();upgrade.exec(migrationTexts[index]);assert.deepEqual(upgrade.prepare('SELECT * FROM audit_events').all(),before);
   for(const table of ['async_export_notification_retry_batches','async_export_notification_retry_items'])assert.equal(upgrade.prepare('SELECT count(*) n FROM '+table).get().n,0);
  }finally{upgrade.close();}
 });
 addBatch('cancelled-batch');
 run("UPDATE async_export_notification_retry_batches SET cancelled_at=?,version=version+1,updated_at=updated_at+1 WHERE id='cancelled-batch'",now);
 test('取消标记保留预览的原始提交状态及冻结选择',()=>{
  const row=get("SELECT state,cancelled_at,committed_at,total_items FROM async_export_notification_retry_batches WHERE id='cancelled-batch'");
  assert.deepEqual({...row},{state:'preview',cancelled_at:now,committed_at:null,total_items:1});
 });
 reject('取消标记一旦设置不能清除',()=>run("UPDATE async_export_notification_retry_batches SET cancelled_at=NULL,version=version+1,updated_at=updated_at+1 WHERE id='cancelled-batch'"));
 reject('取消标记时间不能被改写',()=>run("UPDATE async_export_notification_retry_batches SET cancelled_at=cancelled_at+1,version=version+1,updated_at=updated_at+1 WHERE id='cancelled-batch'"));
 reject('取消标记拒绝负数',()=>run("UPDATE async_export_notification_retry_batches SET cancelled_at=-1,version=version+1,updated_at=updated_at+1 WHERE id='retry-batch-a'"));
 test('0018原位升级保留已有批次结果及审计历史且不创建新任务',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0018_export_notification_retry_controls.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('controls-legacy','Legacy',?,?)").run(now,now);
   upgrade.prepare(batchInsert).run('controls-old','controls-legacy','old-preview',hash,now,now,now+86400000,now+600000);
   upgrade.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) VALUES('old-control-audit','controls-legacy','owner','export_notification_retry_batch.previewed','controls-old','success','fixture',?)").run(now);
   const audits=upgrade.prepare('SELECT * FROM audit_events').all(),batch=upgrade.prepare('SELECT * FROM async_export_notification_retry_batches').get();upgrade.exec(migrationTexts[index]);
   const {cancelled_at,...after}=upgrade.prepare('SELECT * FROM async_export_notification_retry_batches').get();assert.equal(cancelled_at,null);assert.deepEqual(after,{...batch});
   assert.deepEqual(upgrade.prepare('SELECT * FROM audit_events').all(),audits);assert.equal(upgrade.prepare('SELECT count(*) n FROM async_export_notification_retry_items').get().n,0);
   assert.equal(upgrade.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,53);
  }finally{upgrade.close();}
 });
 addBatch('batch-notice-completion');
 run("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id='notice-commit',commit_expected_version=1,committed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='batch-notice-completion'",now);
 run("UPDATE async_export_notification_retry_batches SET state='completed',processed_items=1,requeued_items=1,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id='batch-notice-completion'",now);
 const batchNotice=get("SELECT * FROM async_export_retry_batch_notifications WHERE batch_id='batch-notice-completion'");
 test('批次完成在同事务生成UUID通知快照',()=>{
  assert.match(batchNotice.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(batchNotice.kind,'completed');assert.equal(batchNotice.source_version,3);assert.equal(batchNotice.requeued_items,1);assert.equal(batchNotice.notification_decision,null);
 });
 run("UPDATE async_export_notification_retry_batches SET version=version+1,updated_at=updated_at+1 WHERE id='batch-notice-completion'");
 test('重复汇总不重复生成完成通知',()=>assert.equal(get("SELECT count(*) n FROM async_export_retry_batch_notifications WHERE batch_id='batch-notice-completion'").n,1));
 reject('通知结果快照不可改写',()=>run('UPDATE async_export_retry_batch_notifications SET source_version=source_version+1 WHERE id=?',batchNotice.id));
 reject('通知订阅配置快照不可改写',()=>run("UPDATE async_export_retry_batch_notifications SET endpoint_snapshot_json='[{\"id\":\"later\"}]' WHERE id=?",batchNotice.id));
 reject('通知不能转移到其他邮箱',()=>run("UPDATE async_export_retry_batch_notifications SET mailbox_id='b' WHERE id=?",batchNotice.id));
 reject('通知历史不可删除',()=>run('DELETE FROM async_export_retry_batch_notifications WHERE id=?',batchNotice.id));
 run('UPDATE async_export_retry_batch_notifications SET acknowledged_at=?,version=version+1 WHERE id=?',now+100,batchNotice.id);
 reject('通知确认不可撤销',()=>run('UPDATE async_export_retry_batch_notifications SET acknowledged_at=NULL,version=version+1 WHERE id=?',batchNotice.id));
 test('批次通知确认不会更改执行结果',()=>assert.equal(get("SELECT requeued_items FROM async_export_notification_retry_batches WHERE id='batch-notice-completion'").requeued_items,1));
 test('0019升级不回填旧终态或修改旧批次结果',()=>{
  const upgrade=new DatabaseSync(':memory:');try{
   const index=migrationNames.indexOf('0019_retry_batch_notifications.sql');upgrade.exec('PRAGMA foreign_keys=ON;');upgrade.exec(migrationTexts.slice(0,index).join('\n'));
   upgrade.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('notice-legacy','Legacy',?,?)").run(now,now);
   upgrade.prepare(batchInsert).run('notice-old','notice-legacy','notice-preview',hash,now,now,now+86400000,now+600000);
   upgrade.prepare("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id='legacy-commit',commit_expected_version=1,committed_at=?,version=version+1,updated_at=updated_at+1").run(now);
   upgrade.prepare("UPDATE async_export_notification_retry_batches SET state='completed',processed_items=1,requeued_items=1,completed_at=?,version=version+1,updated_at=updated_at+1").run(now);
   const before=upgrade.prepare('SELECT * FROM async_export_notification_retry_batches').all();upgrade.exec(migrationTexts[index]);assert.deepEqual(upgrade.prepare('SELECT * FROM async_export_notification_retry_batches').all(),before);
   assert.equal(upgrade.prepare('SELECT count(*) n FROM async_export_retry_batch_notifications').get().n,0);assert.equal(upgrade.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,54);
  }finally{upgrade.close();}
 });
 test('最终foreign_key_check与integrity_check通过',()=>{
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal(get('PRAGMA integrity_check').integrity_check,'ok');
 });
 const cfg=await readFile(new URL('../examples/wrangler.personal.jsonc',import.meta.url),'utf8');
 const parsed=JSON.parse(cfg.replace(/^\s*\/\/.*$/gm,''));
 test('配置示例保留DB/R2/EMAIL绑定',()=>{
  assert.equal(parsed.d1_databases[0].binding,'DB');
  assert.equal(parsed.r2_buckets[0].binding,'MAIL_BLOBS');
  assert.equal(parsed.send_email[0].name,'EMAIL');
 });
 // 生成字段字典只读取当前实际SQLite结构。
 if(process.argv.includes('--dictionary')){
  const purposes={
   instance_settings:'单实例配置状态，不存Owner认证秘密', mailboxes:'个人拥有的Agent邮箱',
   mailbox_addresses:'主地址、别名与永久墓碑',mailbox_tokens:'严格绑定一个邮箱的可撤销Token',
   objects:'私有R2对象清单与恢复状态',ingest_receipts:'收信持久化与解析进度',
   threads:'邮箱内会话',messages:'邮件元数据与内容引用',message_addresses:'当前邮箱可见的邮件地址',
   attachments:'附件引用与扫描状态',drafts:'草稿版本与Owner审批',
   daily_send_counters:'按UTC日的个人安全额度',send_reservations:'trigger维护的额度预留',
   outbound_messages:'冻结发送命令与服务商接受状态',outbound_recipients:'逐收件人投递状态',
   send_attempts:'服务商提交尝试与unknown',jobs:'Cron/可选Queues驱动的持久任务',
   idempotency_keys:'邮箱、主体与操作限定的幂等键',events:'持久应用/服务商事件',
   webhook_endpoints:'按邮箱配置的客户通知目标',webhook_deliveries:'稳定事件投递与租约',webhook_delivery_attempts:'有界重试、响应状态与投递租约历史',
   email_delivery_events:'Cloudflare投递事件去重、待关联收件箱和安全状态补账',
   recipient_suppressions:'按邮箱隔离的永久退信/投诉抑制与Owner解除水位',
   cloudflare_suppression_cache:'账户与发信域限定的Cloudflare抑制完整快照',cloudflare_suppression_sync:'同步与解除共用租约和脱敏同步状态',
   cloudflare_suppression_operations:'Owner远端解除幂等命令、未知结果及本地CAS联动',
   cloudflare_suppression_sync_runs:'Owner与定时同步执行历史、失败原因和重试父记录',
   cloudflare_suppression_reconciliations:'只读远端对账的幂等执行记录和租约',cloudflare_suppression_history_events:'不可修改的同步/解除/对账状态时间线',
   cloudflare_suppression_alert_cursors:'带升级屏障的执行日志投影游标，避免补发历史告警',
   cloudflare_suppression_alerts:'Owner失败与未知结果告警、确认版本、重试分组及解决状态',
   cloudflare_suppression_alert_occurrences:'不可修改的告警发生和解决时间线及执行来源',
   alert_notification_policies:'按邮箱配置的告警开关、静默时段、限频及恢复通知策略与CAS版本',
   alert_notification_decisions:'按事件持久且不可修改的通知允许或降噪决策及策略版本',
   alert_notification_state:'邮箱与告警限定的最近通知指纹和限频时钟',
   async_alert_notification_exports:'Owner异步导出幂等任务、固定范围与水位、租约进度、24小时有效期和保留清理墓碑',
   async_alert_notification_export_chunks:'按邮箱和任务限定的私有R2不可修改分片清单、顺序、字节数和校验和',
   async_export_notifications:'导出终态原子快照、Owner确认、事件投影和独立通知准入收据',
   async_export_notification_state:'导出与批次通知按独立命名空间指纹复用的邮箱级Webhook限频时钟',
   async_export_notification_retry_batches:'Owner固定筛选预览、幂等确认、取消围栏与有界批量重试进度和结果历史',
   async_export_retry_batch_notifications:'批量任务完成/失败/待对账通知不可变快照、Owner确认及Webhook准入收据',
   async_export_notification_retry_items:'不可变候选投递版本、逐条租约与排队/跳过/失败/未知结果收据',
   audit_events:'Owner、Token与系统操作审计',
   oauth_clients:'公开OAuth客户端登记与CIMD元数据',oauth_authorization_requests:'Owner同意请求与CSRF摘要',
   oauth_grants:'绑定客户端、邮箱Token和resource的授权族',oauth_authorization_codes:'单次授权码摘要与PKCE绑定',
   oauth_access_tokens:'有界访问令牌摘要与scope',oauth_refresh_tokens:'轮换刷新令牌摘要与同族替换链',
   oauth_registration_windows:'公开客户端登记的固定窗口计数'
  };
  const esc=x=>String(x??'—').replaceAll('|','\\|').replaceAll('\n',' ');
  let md='# 个人版 D1 数据库字段与约束\n\n';
  md+='由 migrations/ 中按序迁移在本地SQLite加载后提取，共'+tables.length+'张STRICT表；当前迁移为 '+migrationNames.join('、')+'。不存在tenant、订阅、PostgreSQL RLS或Stalwart映射。D1仅保存小元数据，原始MIME、正文、附件和冻结快照位于私有R2。业务资源ID为UUID TEXT，OAuth client_id为UUID或HTTPS元数据URL；时间为UTC毫秒INTEGER，布尔为0/1。\n\n';
  md+='一个Token只能绑定一个邮箱。数据库复合外键保障关联完整性，API/MCP仍须逐请求执行邮箱权限。Owner只有一位，由部署配置和Access JWT确定。\n\n';
  md+='## 核心关系\n\n```mermaid\nerDiagram\n mailboxes ||--o{ mailbox_addresses : owns\n mailboxes ||--o{ mailbox_tokens : authorizes\n mailboxes ||--o{ objects : stores\n mailboxes ||--o{ messages : contains\n messages ||--o{ attachments : references\n mailboxes ||--o{ outbound_messages : submits\n outbound_messages ||--o{ outbound_recipients : tracks\n daily_send_counters ||--o{ send_reservations : reserves\n send_reservations ||--o| outbound_messages : permits\n oauth_clients ||--o{ oauth_grants : obtains\n mailbox_tokens ||--o| oauth_grants : scopes\n oauth_grants ||--o{ oauth_authorization_codes : issues\n oauth_grants ||--o{ oauth_access_tokens : authorizes\n oauth_grants ||--o{ oauth_refresh_tokens : rotates\n```\n\n';
  md+='| 表 | 用途 |\n| --- | --- |\n'+tables.map(t=>'| '+t.name+' | '+purposes[t.name]+' |').join('\n')+'\n';
  md+='\n## 约束与应用职责\n\n地址墓碑、跨邮箱引用、Token绑定、审批版本、租约、原子额度预留与冻结发送字段由DDL约束。Owner JWT、Token secret校验、scope、From有效状态、JSON元素语义、URL/SSRF、附件实际扫描、至少一个主地址和发送unknown处置依赖业务实现，不能以SQLite测试替代。send_reservations与outbound命令及jobs在D1 batch中写入；trigger拒绝超额，避免零行UPDATE后仍创建任务。\n\n';
  for(const table of tables){
   md+='\n## '+table.name+'\n\n'+purposes[table.name]+'。\n\n| 字段 | 类型 | 非空 | 默认值 | 主键 |\n| --- | --- | --- | --- | --- |\n';
   for(const c of db.prepare('PRAGMA table_info('+table.name+')').all()) md+='| '+c.name+' | '+c.type+' | '+(c.notnull?'是':'否')+' | '+esc(c.dflt_value)+' | '+(c.pk?'是':'否')+' |\n';
   md+='\n完整表约束：\n\n```sql\n'+table.sql+';\n```\n';
   const related=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all(table.name);
   if(related.length) md+='\n索引与触发器：\n\n```sql\n'+related.map(r=>r.sql+';').join('\n')+'\n```\n';
  }
  await writeFile(new URL('../docs/database.md',import.meta.url),md);
 }
 const docPaths=['../README.md','../docs/README.md','../docs/architecture.md','../docs/project-structure.md','../docs/api-mcp.md','../docs/mcp.md','../docs/oauth.md','../docs/deployment.md','../docs/database.md','../docs/validation.md','../docs/svelte-validation.md'];
 for(const path of docPaths){
  const file=new URL(path,import.meta.url);
  const text=await readFile(file,'utf8');
  for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
   const target=match[1];
   if(/^(https?:|#)/.test(target)) continue;
   await access(new URL(target.split('#')[0],file));
  }
 }
 checks.push('当前文档本地链接有效');
 if(process.argv.includes('--dictionary')){
  const report = '# 个人版数据库结构验证\n\n'
   + '验证环境：Node.js '+process.version+'，内置SQLite '+get('SELECT sqlite_version() version').version+'。在全新内存数据库中按序加载'+tables.length+'张STRICT表，完成'+checks.length+'项检查。\n\n'
   + '没有连接Cloudflare或生产数据库，没有部署应用、修改DNS或实际收发邮件。当前验证为SQLite语法、关系约束与本地事务行为，不能视为D1云端、Worker绑定或实际API/MCP验收。\n\n'
   + '## 执行方式\n\n支持node:sqlite的Node.js 24，无需npm或外部数据库依赖。\n\n```sh\nnode scripts/validate-schema.mjs\nnode scripts/validate-schema.mjs --dictionary\n```\n\n'
   + '[验证脚本](../scripts/validate-schema.mjs)按序加载0001至0019有序迁移，最新为[批次完成与异常通知迁移](../migrations/0019_retry_batch_notifications.sql)，检查合并内容与[快照](schema.sql)一致。--dictionary从实际SQLite元数据重建[快照](schema.sql)、[字段字典](database.md)并更新本记录。每次使用内存数据库，不保留测试数据。\n\n'
   + '## 已通过检查\n\n'+checks.map((c,i)=>(i+1)+'. '+c).join('\n')+'\n\n'
   + '## 验证边界\n\n此脚本只验证SQLite结构与事务，不是多Worker并发压测或完整权限验收。应用另有本地workerd测试覆盖D1失败补账、R2原文、原生事件、Token隔离及官方现代/旧MCP客户端；见[开发验证](development.md)与[MCP接入](mcp.md)。真实Access登录、云端MCP域名和目标Agent客户端仍待部署验收。\n\n'
   + '此脚本验证Webhook复合归属、冻结内容和尝试记录约束；应用测试另行覆盖AES-GCM/HMAC、密钥轮换、租约和HTTP重试，见[Webhook说明](webhooks.md)。云端Email Routing、真实Webhook目标、发送unknown对账、投递状态、域名配置和D1云端迁移仍需端到端验收。本地验证不表示真实邮件已投递。\n\n'
   + 'OAuth增量迁移新增7张表，保留原有22张表与已发布初始迁移；另见[单Worker配置检查记录](svelte-validation.md)。尚无可用部署按钮，[开源与部署设计](deployment.md)明确发布门槛。旧PostgreSQL/PGlite验证结果不适用于当前D1结构。\n';
  await writeFile(new URL('../docs/validation.md',import.meta.url),report);
 }
 console.log(JSON.stringify({runtime:process.version,sqlite:get('SELECT sqlite_version() version').version,tableCount:tables.length,checksPassed:checks.length,checks},null,2));
} finally { db.close(); }
