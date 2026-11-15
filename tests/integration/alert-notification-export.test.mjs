import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',accountId='a'.repeat(32),domain='agent.example.com';
const providerToken='EXPORT_PRIVATE_CF_TOKEN_TEST_ONLY_12345678901234567890';
const createdType='cloudflare.suppression.alert.created',resolvedType='cloudflare.suppression.alert.resolved';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain,
  WEBHOOK_KEYRING:JSON.stringify({activeKid:'export-key',keys:{'export-key':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`,records=box=>`${base(box)}/alert-notification-decisions`,exportPath=box=>`${records(box)}/export`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime,name='Decision export'){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name,localPart:`export-${randomUUID()}`}}),201)).mailbox;}
async function tick(runtime){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
function stateFor(){return {failed:true,cloudflare:[],webhooks:[]};}
function upstream(state){return async request=>{
  const url=new URL(request.url);
  if(url.hostname==='hooks.example.net'){
    state.webhooks.push({url:request.url,headers:Object.fromEntries(request.headers),body:await request.text()});
    return new Response(url.pathname==='/retry'?'PRIVATE_EXPORT_UPSTREAM':null,{status:url.pathname==='/retry'?500:204});
  }
  assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(url.pathname,`/client/v4/accounts/${accountId}/email/sending/suppressions`);
  assert.equal(request.method,'GET');assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);state.cloudflare.push(request.url);
  return state.failed?Response.json({success:false,errors:[{message:'PRIVATE_EXPORT_PROVIDER'}]},{status:500}):Response.json({success:true,result:[],result_info:{next_cursor:null}});
};}
async function subscribe(runtime,box,path='/success'){
  return json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net${path}?private=PRIVATE_EXPORT_URL`,eventTypes:[createdType,resolvedType]}}),201);
}
async function policy(runtime,box,changes){
  const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(box)}/alert-notification-policy`))).policy;
  return json(await runtime.request(`${base(box)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));
}
async function failure(runtime,box,id=randomUUID()){
  await json(await runtime.request(`${base(box)}/cloudflare-suppressions/sync`,{method:'POST',body:{clientRequestId:id}}),502);return id;
}
async function retry(runtime,box,id,failed=true){return json(await runtime.request(`${base(box)}/cloudflare-suppressions/history/${id}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}}),failed?502:200);}
function query(params){return new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]));}
function safe(value,extra=[]){
  const body=typeof value==='string'?value:JSON.stringify(value);
  for(const text of [providerToken,accountId,domain,'PRIVATE_EXPORT_PROVIDER','PRIVATE_EXPORT_UPSTREAM','PRIVATE_EXPORT_URL','claim_token','payload_json',
    'url_snapshot','signing_secret_ciphertext','request_hash','lease_token',...extra])assert.equal(body.includes(text),false,text);
}
function headers(response,format,box,window){
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),format==='csv'?/^text\/csv;\s*charset=utf-8$/i:/^application\/json;\s*charset=utf-8$/i);
  assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const name=`alert-notification-decisions-${box.id}-${window.from}-${window.to}.${format}`;
  assert.equal(response.headers.get('content-disposition'),`attachment; filename="${name}"`);
}
function parseCsv(raw){
  assert.equal(raw.charCodeAt(0),0xfeff,'CSV keeps a UTF-8 BOM for spreadsheet imports');assert.ok(raw.endsWith('\r\n'));
  const rows=[];let row=[],field='',quoted=false;
  for(let index=1;index<raw.length;index++){
    const char=raw[index];
    if(quoted){if(char==='"'){if(raw[index+1]==='"'){field+='"';index++;}else quoted=false;}else field+=char;}
    else if(char==='"'){assert.equal(field,'');quoted=true;}
    else if(char===','){row.push(field);field='';}
    else if(char==='\r'&&raw[index+1]==='\n'){row.push(field);rows.push(row);row=[];field='';index++;}
    else{assert.notEqual(char,'\n');field+=char;}
  }
  assert.equal(quoted,false);assert.deepEqual(row,[]);assert.equal(field,'');
  const names=rows.shift();assert.equal(new Set(names).size,names.length);
  return rows.map(values=>{assert.equal(values.length,names.length);return Object.fromEntries(names.map((name,index)=>[name,values[index]]));});
}
async function csvResponse(response){const raw=Buffer.from(await response.arrayBuffer()).toString('utf8');safe(raw);return {raw,rows:parseCsv(raw)};}
async function evidence(runtime){
  const result={};for(const table of ['events','alert_notification_decisions','alert_notification_state','cloudflare_suppression_alerts','audit_events','webhook_deliveries','webhook_delivery_attempts','jobs'])
    result[table]=(await runtime.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}
const uuidSql="lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))";
async function seed(runtime,box,count,{at=Date.now()-1000,alertId=randomUUID(),prefix=randomUUID()}={}){
  await runtime.db.batch([
    runtime.db.prepare(`WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at,webhook_published_at)
      SELECT ${uuidSql},?,'app',?||i,?,json_object('alertId',?,'kind','sync','status','open','outcome','failed','errorCode','cloudflare_api_unavailable'),?,?,? FROM n`)
      .bind(count,box.id,prefix,createdType,alertId,at,at,at),
    runtime.db.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token)
      SELECT id,mailbox_id,?,'no_subscribers',0,?,? FROM events WHERE mailbox_id=? AND source_event_id LIKE ?`).bind(alertId,at,randomUUID(),box.id,prefix+'%')
  ]);
  return (await runtime.db.prepare('SELECT event_id FROM alert_notification_decisions WHERE mailbox_id=? ORDER BY rowid').bind(box.id).all()).results;
}

test('CSV and JSON export the entire selected decision window, noise counts and actual per-subscription outcomes rather than the current page',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),success=await subscribe(runtime,box),pending=await subscribe(runtime,box,'/retry');
  await policy(runtime,box,{repeatIntervalSeconds:3600});const source=await failure(runtime,box);await tick(runtime);
  assert.equal(state.webhooks.length,2);
  for(const record of state.webhooks){const match=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(record.headers['x-agent-mail-signature']);assert.ok(match);
    const secret=record.url.includes('/retry')?pending.secret:success.secret;assert.equal(match[2],createHmac('sha256',secret).update(`${match[1]}.${record.headers['x-agent-mail-delivery']}.${record.body}`).digest('hex'));}
  await retry(runtime,box,source);await tick(runtime);
  const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();await policy(runtime,box,{quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440});
  await retry(runtime,box,source);await tick(runtime);await policy(runtime,box,{enabled:false,quietEnabled:false});await retry(runtime,box,source);await tick(runtime);
  await policy(runtime,box,{enabled:true,recoveryEnabled:false});state.failed=false;await retry(runtime,box,source,false);await tick(runtime);
  for(const endpoint of [success.endpoint,pending.endpoint])await json(await runtime.request(`${base(box)}/webhooks/${endpoint.id}`,{method:'PATCH',body:{expectedUpdatedAt:endpoint.updatedAt,status:'paused'}}));
  state.failed=true;for(let index=0;index<8;index++){await failure(runtime,box);await tick(runtime);}
  const page=await json(await runtime.request(`${records(box)}?limit=10`));assert.equal(page.decisions.length,10);assert.equal(page.summary.total,13);assert.ok(page.nextCursor);
  const params={from:page.window.from,to:page.window.to,decision:'all',eventType:'all'},before=await evidence(runtime),network=state.webhooks.length+state.cloudflare.length;
  const response=await runtime.request(`${exportPath(box)}?${query({...params,format:'json'})}`);headers(response,'json',box,page.window);const data=await response.json();safe(data,[success.secret,pending.secret]);
  assert.equal(data.version,1);assert.equal(data.mailboxId,box.id);assert.deepEqual(data.window,page.window);assert.deepEqual(data.filters,{decision:'all',eventType:'all'});
  assert.equal(Number.isSafeInteger(data.generatedAt),true);assert.ok(data.snapshot.decisionWatermark>0);assert.equal(data.decisions.length,13);assert.deepEqual(data.summary,page.summary);
  assert.deepEqual(data.summary.byDecision,{allowed:1,disabled:1,quiet_hours:1,repeat_limited:1,recovery_disabled:1,no_subscribers:8});
  assert.deepEqual(data.decisions.map(item=>item.eventId).slice(0,10),page.decisions.map(item=>item.eventId));
  const admitted=data.decisions.find(item=>item.decision==='allowed');assert.equal(admitted.deliveries.length,2);assert.deepEqual(admitted.deliveries.map(item=>item.state).sort(),['cancelled','succeeded']);
  assert.equal(admitted.delivery.attempts,2);assert.deepEqual(admitted.deliveries.map(item=>item.lastHttpStatus).sort(),[204,500]);
  const csv=await runtime.request(`${exportPath(box)}?${query({...params,format:'csv'})}`);headers(csv,'csv',box,page.window);const parsed=await csvResponse(csv);
  assert.equal(parsed.rows.filter(item=>item.row_type==='decision').length,13);assert.equal(parsed.rows.filter(item=>item.row_type==='delivery').length,2);
  const metrics=Object.fromEntries(parsed.rows.filter(item=>item.row_type==='summary').map(item=>[item.metric,item.value]));
  assert.equal(metrics.total,'13');assert.equal(metrics.allowed,'1');assert.equal(metrics.skipped,'12');assert.equal(metrics['by_decision.quiet_hours'],'1');assert.equal(metrics['by_decision.repeat_limited'],'1');
  assert.equal(metrics['delivery.total'],'2');assert.equal(metrics['delivery.succeeded'],'1');assert.equal(metrics['delivery.cancelled'],'1');
  assert.equal(parsed.rows.find(item=>item.row_type==='decision'&&item.event_id===admitted.eventId).delivery_total,'2');
  assert.deepEqual(parsed.rows.filter(item=>item.row_type==='delivery').map(item=>item.last_http_status).sort(),['204','500']);
  const filtered=await json(await runtime.request(`${exportPath(box)}?${query({...params,format:'json',decision:'quiet_hours',eventType:'created'})}`));assert.equal(filtered.decisions.length,1);assert.equal(filtered.summary.total,1);assert.equal(filtered.summary.byDecision.quiet_hours,1);
  const recovery=await json(await runtime.request(`${exportPath(box)}?${query({...params,format:'json',eventType:'resolved'})}`));assert.equal(recovery.decisions.length,1);assert.equal(recovery.decisions[0].decision,'recovery_disabled');
  assert.deepEqual(await evidence(runtime),before);assert.equal(state.webhooks.length+state.cloudflare.length,network);
});

test('export validates every filter, produces empty typed files, and neutralizes spreadsheet formulas without exporting raw event payload',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),now=Date.now(),window={from:now-1000,to:now+1};
  for(const suffix of ['', '?format=', '?format=xml','?format=json&format=csv','?format=json&limit=10','?format=json&cursor=bad','?format=json&extra=1',
    '?format=json&from=1&to=1','?format=csv&from=0&to=2678400001','?format=csv&from=1e3','?format=json&decision=unknown','?format=json&eventType=message.received',
    '?format=csv&decision=allowed&decision=quiet_hours',`?format=json&to=${now+86_400_000}`]){
    const response=await runtime.request(exportPath(box)+suffix);assert.equal(response.status,400,suffix);assert.equal(response.headers.has('content-disposition'),false);assert.ok((await response.json()).error.code);
  }
  const empty=await runtime.request(`${exportPath(box)}?${query({...window,format:'json'})}`);headers(empty,'json',box,window);const data=await empty.json();assert.deepEqual(data.decisions,[]);assert.equal(data.summary.total,0);assert.equal(data.summary.delivery.total,0);
  const csv=await runtime.request(`${exportPath(box)}?${query({...window,format:'csv'})}`);headers(csv,'csv',box,window);const parsed=await csvResponse(csv);assert.ok(parsed.rows.some(row=>row.row_type==='metadata'));assert.ok(parsed.rows.some(row=>row.row_type==='summary'));assert.equal(parsed.rows.some(row=>row.row_type==='decision'||row.row_type==='delivery'),false);
  const at=Date.now()-1;await seed(runtime,box,1,{at,alertId:'=2+2'});const corrupt=await runtime.request(`${exportPath(box)}?format=csv`),formula=await csvResponse(corrupt);
  const row=formula.rows.find(item=>item.row_type==='decision');assert.equal(row.alert_id,"'=2+2");assert.equal(row.event_available,'false');assert.equal(row.event_type,'');
  for(const record of formula.rows)for(const value of Object.values(record))assert.equal(/^[\t\r\n ]*[=+\-@]/.test(value),false,'No cell starts with a spreadsheet formula trigger');
});

async function oauthToken(runtime,box){
  const resource=`${api}/mcp`,redirect='https://export-client.example/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Export denied OAuth',redirect_uris:[redirect],scope:'mail:read',token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})}),201);
  const url=new URL('/owner/oauth/authorize','https://console.example.com');url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',resource,scope:'mail:read',state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const page=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(page.status,200);const html=await page.text();
  const requestId=/name="requestId"[^>]*value="([^\"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^\"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:'https://console.example.com','Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},body:new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id,scope:'mail:read'}).toString(),redirect:'manual'});assert.equal(consent.status,303);
  return json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:registered.client_id,resource,code:new URL(consent.headers.get('Location')).searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier}).toString()}));
}
async function clientFor(runtime,secret){
  const client=registerMcpClient(runtime,new Client({name:'export-negative-integration',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}}));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init);return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),signal:request.signal});
  }}),{timeout:10_000});return client;
}

test('exports remain Owner-only, mailbox-scoped and read-only for paused or credential-missing installations; Agent grants gain no export capability',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),other=await mailbox(runtime);await failure(runtime,box);await tick(runtime);
  const token=await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Export denied',scopes:['mail:read']}}),201),oauth=await oauthToken(runtime,box);
  const location=exportPath(box)+'?format=json';assert.equal((await runtime.request(location,{authenticated:false})).status,401);
  for(const secret of [token.secret,oauth.access_token]){
    assert.equal((await runtime.request(location,{authenticated:false,headers:{Authorization:`Bearer ${secret}`}})).status,401);
    assert.equal((await runtime.mf.dispatchFetch(`${api}/v1/alert-notification-decisions/export?format=json`,{headers:{Authorization:`Bearer ${secret}`}})).status,secret===token.secret?404:401);
    const client=await clientFor(runtime,secret),listed=await client.listTools();assert.equal(listed.tools.some(tool=>tool.name.includes('notification_export')),false);
    await assert.rejects(()=>client.callTool({name:'export_alert_notification_decisions',arguments:{format:'json'}}));
  }
  assert.equal((await runtime.request(location,{method:'POST',body:{}})).status,405);
  const empty=await json(await runtime.request(exportPath(other)+'?format=json'));assert.deepEqual(empty.decisions,[]);assert.equal(empty.summary.total,0);
  await json(await runtime.request(base(box),{method:'PATCH',body:{status:'paused',expectedUpdatedAt:box.updatedAt}}));await runtime.updateBindings({EMAIL_SUPPRESSIONS_API_TOKEN:'',EMAIL_SUPPRESSIONS_ACCOUNT_ID:'',EMAIL_SUPPRESSIONS_DOMAIN:''});
  const before=await evidence(runtime),network=state.cloudflare.length+state.webhooks.length,data=await json(await runtime.request(location));assert.equal(data.decisions.length,1);safe(data);
  const csv=await runtime.request(exportPath(box)+'?format=csv');await csvResponse(csv);assert.deepEqual(await evidence(runtime),before);assert.equal(state.cloudflare.length+state.webhooks.length,network);
});

test('export limits reject oversized decision or delivery sets with a JSON error and never return a partial attachment',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings:{WEBHOOK_KEYRING:bindings.WEBHOOK_KEYRING}});t.after(()=>disposeOwnerRuntime(runtime));const oversized=await mailbox(runtime),fanout=await mailbox(runtime);
  await seed(runtime,oversized,1001);await seed(runtime,fanout,501);
  for(let index=0;index<10;index++)await subscribe(runtime,fanout);
  await runtime.db.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at)
    SELECT ${uuidSql},n.mailbox_id,w.id,n.event_id,'pending',1,w.secret_version,w.signing_secret_ciphertext,w.url,'{}',1,1
    FROM alert_notification_decisions n JOIN webhook_endpoints w ON w.mailbox_id=n.mailbox_id WHERE n.mailbox_id=? LIMIT 5001`).bind(fanout.id).run();
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM webhook_deliveries WHERE mailbox_id=?').bind(fanout.id).first('n'),5001);
  for(const box of [oversized,fanout])for(const format of ['json','csv']){
    const response=await runtime.request(`${exportPath(box)}?format=${format}`);assert.equal(response.status,413);assert.equal(response.headers.has('content-disposition'),false);
    assert.match(response.headers.get('content-type'),/^application\/json/);assert.equal((await response.json()).error.code,'alert_notification_export_too_large');
  }
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM alert_notification_decisions WHERE mailbox_id=?').bind(oversized.id).first('n'),1001);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM webhook_deliveries WHERE mailbox_id=?').bind(fanout.id).first('n'),5001);
});
