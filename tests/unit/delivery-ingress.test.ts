import {createHmac} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import {ServiceError,type RuntimeEnv} from '../../src/lib/server/core/types';
const mocks=vi.hoisted(()=>({ingest:vi.fn(),configured:vi.fn()}));
vi.mock('../../src/lib/server/core/delivery-events',()=>({ingestDeliveryEvent:mocks.ingest,deliveryEventsConfigured:mocks.configured}));
import {handleDeliveryBridge,handleDeliveryQueue,verifyDeliveryBridgeSignature} from '../../worker/handlers/delivery-events';

const secret='independent-bridge-secret-'.repeat(3),env={EMAIL_EVENT_BRIDGE_SECRET:secret,EMAIL_EVENT_QUEUE:'email-events'} as RuntimeEnv;
const raw='{"subject":"你好 😀","test":true}',timestamp=String(Math.floor(Date.now()/1000));
const sign=(body=raw,time=timestamp)=>'v1='+createHmac('sha256',secret).update(time+'.').update(body).digest('hex');
function request(body=raw,headers:Record<string,string>={},path='/callbacks/cloudflare-email'){
  return new Request('https://api.example.com'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Mail-Timestamp':timestamp,'X-Agent-Mail-Signature':sign(body),...headers},body});
}
beforeEach(()=>{vi.clearAllMocks();mocks.configured.mockReturnValue(true);mocks.ingest.mockResolvedValue({outcome:'pending'});});

it('verifies exact UTF-8 bytes and rejects altered, stale, future or malformed bridge signatures',async()=>{
  const bytes=new TextEncoder().encode(raw);
  expect(await verifyDeliveryBridgeSignature(secret,timestamp,sign(),bytes)).toBe(true);
  expect(await verifyDeliveryBridgeSignature(secret,timestamp,sign(),new TextEncoder().encode(raw+' '))).toBe(false);
  for(const [time,sig] of [[timestamp,sign().toUpperCase()],['bad',sign()],[String(Number(timestamp)-301),sign(raw,String(Number(timestamp)-301))],[String(Number(timestamp)+301),sign(raw,String(Number(timestamp)+301))]])
    expect(await verifyDeliveryBridgeSignature(secret,time,sig,bytes,Number(timestamp)*1000)).toBe(false);
});
it('fails closed when disabled, and authenticates before parsing or calling persistence',async()=>{
  expect(await handleDeliveryBridge(request(),{...env,EMAIL_EVENT_BRIDGE_SECRET:''})).toHaveProperty('status',404);
  mocks.configured.mockReturnValue(false);expect(await handleDeliveryBridge(request(),env)).toHaveProperty('status',404);mocks.configured.mockReturnValue(true);
  expect(await handleDeliveryBridge(request('not json',{'X-Agent-Mail-Signature':sign()}),env)).toHaveProperty('status',401);
  expect(mocks.ingest).not.toHaveBeenCalled();
  expect(await handleDeliveryBridge(request('not json'),env)).toHaveProperty('status',400);
  expect(await handleDeliveryBridge(request('"'+'x'.repeat(65_536)+'"'),env)).toHaveProperty('status',413);
  expect(mocks.ingest).not.toHaveBeenCalled();
  const valid=await handleDeliveryBridge(request(),env);expect(valid).toHaveProperty('status',200);expect(await valid!.json()).toEqual({ok:true,outcome:'pending'});
  expect(mocks.ingest).toHaveBeenCalledWith(env,JSON.parse(raw));
});
it('limits bridge handling to the exact path and method and returns only safe outcomes',async()=>{
  expect(await handleDeliveryBridge(request(raw,{},'/owner/api/mailboxes'),env)).toBeNull();
  expect(await handleDeliveryBridge(request(raw,{},'/callbacks/cloudflare-email/'),env)).toBeNull();
  expect(await handleDeliveryBridge(new Request('https://api.example.com/callbacks/cloudflare-email'),env)).toHaveProperty('status',405);
  expect(await handleDeliveryBridge(request(raw,{},'/callbacks/cloudflare-email?box=attacker'),env)).toHaveProperty('status',400);
  expect(await handleDeliveryBridge(request(raw,{'Content-Type':'text/plain'}),env)).toHaveProperty('status',415);
  mocks.ingest.mockResolvedValue({outcome:'conflict'});expect(await handleDeliveryBridge(request(),env)).toHaveProperty('status',409);
  mocks.ingest.mockRejectedValue(new Error('private SQL error'));const failure=await handleDeliveryBridge(request(),env);
  expect(failure).toHaveProperty('status',503);expect(await failure!.text()).not.toContain('private');
});
it('acks malformed queue items individually, retries storage failures, and refuses other queues',async()=>{
  const message=(body:unknown)=>({body,ack:vi.fn(),retry:vi.fn()}),a=message({n:1}),b=message({n:2}),c=message({n:3});
  const batch={queue:'email-events',messages:[a,b,c],retryAll:vi.fn()} as unknown as MessageBatch<unknown>;
  const logs=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    mocks.ingest.mockResolvedValueOnce({outcome:'applied'}).mockRejectedValueOnce(new ServiceError('invalid_event',400)).mockRejectedValueOnce(new Error('PRIVATE_SQL'));
    await handleDeliveryQueue(batch,env);expect(a.ack).toHaveBeenCalledOnce();expect(b.ack).toHaveBeenCalledOnce();expect(c.ack).not.toHaveBeenCalled();expect(c.retry).toHaveBeenCalledWith({delaySeconds:60});
    expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE_SQL');mocks.ingest.mockClear();
    await handleDeliveryQueue({...batch,queue:'other'} as MessageBatch<unknown>,env);expect(batch.retryAll).toHaveBeenCalledWith({delaySeconds:60});expect(mocks.ingest).not.toHaveBeenCalled();
  }finally{logs.mockRestore();}
});
