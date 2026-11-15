import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

async function create(runtime,name,localPart) {
  const response=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name,localPart}});
  assert.equal(response.status,201);return (await response.json()).mailbox;
}

test('final Worker exposes scoped bidirectional pages, strict cursors and side-effect-free reader GETs',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const {request,db}=runtime;
  const a=await create(runtime,'Research','research'),b=await create(runtime,'Other','other');
  const messages=await seedMessages(runtime,a.id,{count:25});
  await seedMessages(runtime,b.id,{text:'OTHER_MAILBOX_SECRET'});
  const base=`/owner/api/mailboxes/${a.id}/messages`;
  const first=await request(`${base}?limit=10`);assert.equal(first.status,200);assert.match(first.headers.get('cache-control'),/no-store/);
  const page1=await first.json();assert.equal(page1.messages.length,10);assert.equal(page1.previousCursor,null);
  const page2=await (await request(`${base}?limit=10&cursor=${page1.nextCursor}`)).json();assert.equal(page2.messages.length,10);
  const previous=await (await request(`${base}?limit=10&cursor=${page2.previousCursor}`)).json();
  assert.deepEqual(previous.messages.map(value=>value.id),page1.messages.map(value=>value.id));
  const page3=await (await request(`${base}?limit=10&cursor=${page2.nextCursor}`)).json();assert.equal(page3.messages.length,5);assert.equal(page3.nextCursor,null);
  assert.deepEqual([...page1.messages,...page2.messages,...page3.messages].map(value=>value.id),messages.map(value=>value.id));
  for(const path of [`${base}?limit=101`,`${base}?cursor=bad`,`${base}?limit=20&cursor=${page1.nextCursor}`,`${base}?limit=10&read=unread&cursor=${page1.nextCursor}`,
    `/owner/api/mailboxes/${b.id}/messages?limit=10&cursor=${page1.nextCursor}`]) assert.equal((await request(path)).status,400,path);
  assert.equal((await request(base,{authenticated:false})).status,401);
  const detail=await request(`${base}/${messages[0].id}`);assert.equal(detail.status,200);
  assert.equal((await detail.json()).body.text,messages[0].text);
  const rendered=await request(`/owner/mailboxes/${a.id}/messages?message=${messages[0].id}`);
  assert.equal(rendered.status,200);const html=await rendered.text();assert.match(html,/邮件正文/);assert.equal(html.includes('OTHER_MAILBOX_SECRET'),false);
  assert.equal(await db.prepare('SELECT is_read FROM messages WHERE id=?').bind(messages[0].id).first('is_read'),0);
  const filtered=await (await request(`${base}?read=read`)).json();assert.equal(filtered.messages.length,0);
});

test('mail:read tokens can read only their mailbox and cannot mark mail; Owner PATCH requires JWT and Origin',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const {mf,db,request}=runtime;
  const a=await create(runtime,'A','a'),b=await create(runtime,'B','b');
  const [own]=await seedMessages(runtime,a.id,{text:'A_PRIVATE_BODY'}),[other]=await seedMessages(runtime,b.id,{text:'B_PRIVATE_BODY'});
  const issued=await (await request(`/owner/api/mailboxes/${a.id}/tokens`,{method:'POST',body:{name:'Reader',scopes:['mail:read']}})).json();
  const headers={Authorization:`Bearer ${issued.secret}`};
  const detailUrl=`https://api.example.com/v1/messages/${own.id}`;
  const response=await mf.dispatchFetch(detailUrl,{headers});assert.equal(response.status,200);const detail=await response.json();
  assert.equal(detail.body.text,'A_PRIVATE_BODY');assert.equal(JSON.stringify(detail).includes(own.bodyKey),false);
  assert.equal((await mf.dispatchFetch(`https://api.example.com/v1/messages/${other.id}`,{headers})).status,404);
  assert.equal((await mf.dispatchFetch(detailUrl,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:'{"isRead":true}'})).status,405);
  const base=`/owner/api/mailboxes/${a.id}/messages`;
  assert.equal((await request(`${base}/${other.id}`)).status,404);
  assert.equal((await request(`${base}/${other.id}`,{method:'PATCH',body:{isRead:true}})).status,404);
  assert.equal((await request(`${base}/${own.id}`,{method:'PATCH',authenticated:false,headers,body:{isRead:true}})).status,401);
  assert.equal((await request(`${base}/${own.id}`,{method:'PATCH',headers:{Origin:'https://evil.example'},body:{isRead:true}})).status,403);
  const missingOrigin=await mf.dispatchFetch(`https://console.example.com${base}/${own.id}`,{method:'PATCH',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,'Content-Type':'application/json'},body:'{"isRead":true}'});
  assert.equal(missingOrigin.status,403);
  assert.equal(await db.prepare('SELECT is_read FROM messages WHERE id=?').bind(own.id).first('is_read'),0);
  assert.equal((await request(`${base}/${own.id}`,{method:'PATCH',body:{isRead:1}})).status,400);
  for(let i=0;i<2;i++)assert.equal((await request(`${base}/${own.id}`,{method:'PATCH',body:{isRead:true}})).status,200);
  assert.equal((await (await mf.dispatchFetch(detailUrl,{headers})).json()).message.is_read,1);
  assert.equal(await db.prepare("SELECT count(*) n FROM audit_events WHERE action='message.read_state_changed' AND mailbox_id=?").bind(a.id).first('n'),1);
  assert.equal((await (await request(`${base}?read=unread`)).json()).messages.length,0);
  assert.equal((await request(`${base}/${own.id}`,{method:'PATCH',body:{isRead:false}})).status,200);
  await request(`/owner/api/mailboxes/${a.id}/tokens/${issued.token.id}`,{method:'DELETE'});
  assert.equal((await mf.dispatchFetch(detailUrl,{headers})).status,401);
});

test('reader reports body availability honestly and keeps unsafe mail as text data',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const a=await create(runtime,'Reader','reader');
  const payload='<script>globalThis.__mailXss=true</script>\n<img src="https://tracking.invalid/pixel" onerror="alert(1)">';
  const [unsafe]=await seedMessages(runtime,a.id,{text:payload,prefix:'<script>unsafe subject</script>'});
  const base=`/owner/api/mailboxes/${a.id}/messages`;
  const data=await (await runtime.request(`${base}/${unsafe.id}`)).json();assert.equal(data.body.text,payload);
  assert.deepEqual(data.capabilities,{htmlRendering:true,attachmentExtraction:true});
  assert.equal(data.attachments.status,'not_extracted');
  await runtime.bucket.delete(unsafe.bodyKey);
  const missing=await (await runtime.request(`${base}/${unsafe.id}`)).json();assert.equal(missing.body.status,'unavailable');assert.equal(missing.body.text,null);
  const [unextracted]=await seedMessages(runtime,a.id,{text:null});
  assert.equal((await (await runtime.request(`${base}/${unextracted.id}`)).json()).body.status,'not_extracted');
  const html=await (await runtime.request(`/owner/mailboxes/${a.id}/messages?message=${unsafe.id}`)).text();
  assert.match(html,/正文暂不可用/);assert.equal(html.includes(unsafe.bodyKey),false);
});
