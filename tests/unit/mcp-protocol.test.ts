import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type {OwnerContext} from '../../src/lib/server/core/owner';

const probes=vi.hoisted(()=>({write:vi.fn()}));
vi.mock('../../src/lib/server/mcp/tools',()=>({
  registerMailTools(server:McpServer) {
    server.registerTool('protocol_write_probe',{inputSchema:z.object({}).strict()},async()=>{
      probes.write();
      return {content:[{type:'text' as const,text:'done'}]};
    });
  }
}));
import {handleMcp,MCP_MAX_REQUEST_BYTES} from '../../src/lib/server/mcp/server';

const base='https://api.example.com/mcp';
const token={kind:'token' as const,mailboxId:'e801d333-31b7-4b50-8d2f-830649c620a5',tokenId:'c6793549-4ced-463a-8adf-94993af26314',canRead:false,canDraft:false,canSend:false};
const ctx={env:{API_ORIGIN:'https://api.example.com'},actor:token,requestId:'protocol-test'} as OwnerContext;
const accept='application/json, text/event-stream';
const modernMeta={
  'io.modelcontextprotocol/protocolVersion':'2026-07-28',
  'io.modelcontextprotocol/clientInfo':{name:'protocol-tests',version:'1.0.0'},
  'io.modelcontextprotocol/clientCapabilities':{}
};
const rpc=(method:string,params:Record<string,unknown>={},id:unknown=1)=>({jsonrpc:'2.0',id,method,params});
function request(body:unknown,headers:Record<string,string>={}) {
  return new Request(base,{method:'POST',headers:{'Content-Type':'application/json',Accept:accept,...headers},body:JSON.stringify(body)});
}
function modern(method:string,params:Record<string,unknown>={},headers:Record<string,string>={}) {
  return request(rpc(method,{...params,_meta:modernMeta}),{
    'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,
    ...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),...headers
  });
}
async function body(response:Response):Promise<Record<string,any>> {
  if(response.headers.get('content-type')?.includes('application/json')) return response.json();
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text=await response.text();
  const data=text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean);
  expect(data.length).toBeGreaterThan(0);
  return JSON.parse(data.at(-1)!);
}
beforeEach(()=>probes.write.mockClear());

describe('MCP stateless transport and message boundaries',()=>{
  it('requires an authenticated mailbox principal even before protocol handling',async()=>{
    for(const actor of [null,{kind:'owner' as const,email:'owner@example.com'}]) {
      await expect(handleMcp(request(rpc('ping')),{...ctx,actor})).rejects.toMatchObject({code:'unauthorized',status:401});
    }
  });

  it('serves legacy initialize, fresh-request ping and initialized notifications without sessions',async()=>{
    const initialized=await handleMcp(request(rpc('initialize',{
      protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-tests',version:'1.0.0'}
    })),ctx);
    expect(initialized.status).toBe(200);expect(initialized.headers.get('Mcp-Session-Id')).toBeNull();
    expect(initialized.headers.get('cache-control')).toContain('no-store');
    const result=await body(initialized);
    expect(result).toMatchObject({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',serverInfo:{name:'agent-mail'},capabilities:{tools:{listChanged:false}}}});
    const ping=await handleMcp(request(rpc('ping',{},'fresh-id'),{'MCP-Protocol-Version':'2025-11-25'}),ctx);
    expect(ping.status).toBe(200);expect(await body(ping)).toMatchObject({jsonrpc:'2.0',id:'fresh-id',result:{}});
    const notification=await handleMcp(request({jsonrpc:'2.0',method:'notifications/initialized'}),ctx);
    expect(notification.status).toBe(202);expect(await notification.text()).toBe('');
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('serves modern discover and tools/list as JSON with private cache and no session identity',async()=>{
    const discover=await handleMcp(modern('server/discover'),ctx);
    expect(discover.status).toBe(200);expect(discover.headers.get('content-type')).toContain('application/json');
    expect(discover.headers.get('Mcp-Session-Id')).toBeNull();expect(discover.headers.get('cache-control')).toContain('no-store');
    const result=await body(discover);
    expect(result.jsonrpc).toBe('2.0');expect(result.error).toBeUndefined();expect(JSON.stringify(result.result)).toContain('2026-07-28');
    const listed=await handleMcp(modern('tools/list'),ctx);
    expect(listed.status).toBe(200);const listResult=await body(listed);
    expect(listResult.result.tools.map((tool:{name:string})=>tool.name)).toEqual(['protocol_write_probe']);
    expect(listResult.result.cacheScope).toBe('private');expect(listResult.result.ttlMs).toBe(0);
  });

  it('does not expose GET streams or DELETE sessions',async()=>{
    for(const method of ['GET','DELETE','PUT']) {
      const response=await handleMcp(new Request(base,{method}),ctx);
      expect(response.status).toBe(405);expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched modern protocol/method/name mirrors before tool execution',async()=>{
    const mismatches:Record<string,string>[]=[
      {'MCP-Protocol-Version':''},{'MCP-Protocol-Version':'2025-11-25'},
      {'Mcp-Method':''},{'Mcp-Method':'tools/list'},{'Mcp-Name':''},{'Mcp-Name':'another-tool'}
    ];
    for(const headers of mismatches) {
      const response=await handleMcp(modern('tools/call',{name:'protocol_write_probe',arguments:{}},headers),ctx);
      expect(response.status).toBe(400);expect((await body(response)).error.code).toBe(-32020);
    }
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('rejects unsupported modern revisions with supported-version guidance',async()=>{
    const response=await handleMcp(request(rpc('tools/list',{_meta:{...modernMeta,'io.modelcontextprotocol/protocolVersion':'2099-01-01'}}),{
      'MCP-Protocol-Version':'2099-01-01','Mcp-Method':'tools/list'
    }),ctx);
    expect(response.status).toBe(400);const result=await body(response);
    expect(result.error.code).toBe(-32022);expect(result.error.data.supported).toContain('2026-07-28');
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('requires JSON content and an Accept declaration for both response formats',async()=>{
    for(const req of [request(rpc('ping'),{'Content-Type':'text/plain'}),request(rpc('ping'),{'Content-Type':''})]) {
      const response=await handleMcp(req,ctx);expect(response.status).toBe(415);expect((await body(response)).error).toBeDefined();
    }
    for(const headers of [{Accept:''},{Accept:'application/json'},{Accept:'text/event-stream'}]) {
      const legacy=await handleMcp(request(rpc('ping'),headers),ctx);expect(legacy.status).toBe(406);
      const current=await handleMcp(modern('tools/call',{name:'protocol_write_probe',arguments:{}},headers),ctx);expect(current.status).toBe(406);
    }
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('rejects subscription long streams even when the requested filter is empty or unsupported',async()=>{
    for(const notifications of [{},{toolsListChanged:true}]) {
      const response=await handleMcp(modern('subscriptions/listen',{notifications}),ctx);
      if(response.headers.get('content-type')?.includes('text/event-stream')) await response.body?.cancel();
      expect(response.status).toBe(404);expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('content-type')).not.toContain('text/event-stream');
      expect(await body(response)).toMatchObject({jsonrpc:'2.0',id:1,error:{code:-32601}});
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    const legacy=await handleMcp(request(rpc('subscriptions/listen',{notifications:{}},'legacy-subscription'),{
      'MCP-Protocol-Version':'2025-11-25'
    }),ctx);
    expect(legacy.status).toBe(404);expect(await body(legacy)).toMatchObject({id:'legacy-subscription',error:{code:-32601}});
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('honors zero-quality Accept exclusions before callbacks and accepts positive weights',async()=>{
    for(const Accept of ['application/json;q=0, text/event-stream','application/json, text/event-stream;q=0',
      'application/json;q=0.7, text/event-stream;q=0','application/json;q=0, text/event-stream;q=0']) {
      const response=await handleMcp(modern('tools/call',{name:'protocol_write_probe',arguments:{}},{Accept}),ctx);
      expect(response.status).toBe(406);expect((await body(response)).error).toBeDefined();
    }
    expect(probes.write).not.toHaveBeenCalled();
    const accepted=await handleMcp(modern('tools/call',{name:'protocol_write_probe',arguments:{}},{Accept:'application/json;q=0.8, text/event-stream;q=0.2'}),ctx);
    expect(accepted.status).toBe(200);expect((await body(accepted)).result.isError).not.toBe(true);
    expect(probes.write).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON, batches and invalid request IDs without side effects',async()=>{
    const malformed=await handleMcp(new Request(base,{method:'POST',headers:{'Content-Type':'application/json',Accept:accept},body:'{"jsonrpc":'}),ctx);
    expect(malformed.status).toBe(400);expect((await body(malformed)).error.code).toBe(-32700);
    for(const value of [[],[rpc('tools/call',{name:'protocol_write_probe',arguments:{}})],
      rpc('tools/call',{name:'protocol_write_probe',arguments:{}},null),rpc('tools/call',{name:'protocol_write_probe',arguments:{}},true),
      rpc('tools/call',{name:'protocol_write_probe',arguments:{}},{}),{jsonrpc:'1.0',id:1,method:'tools/call',params:{name:'protocol_write_probe',arguments:{}}}]) {
      const response=await handleMcp(request(value,{'MCP-Protocol-Version':'2025-11-25'}),ctx);
      expect(response.status).toBe(400);expect((await body(response)).error).toBeDefined();
    }
    expect(probes.write).not.toHaveBeenCalled();
  });

  it('never turns a tools/call notification into a mutating tool request',async()=>{
    for(const req of [
      request({jsonrpc:'2.0',method:'tools/call',params:{name:'protocol_write_probe',arguments:{}}}),
      request({jsonrpc:'2.0',method:'tools/call',params:{name:'protocol_write_probe',arguments:{},_meta:modernMeta}},
        {'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'protocol_write_probe'})
    ]) {
      const response=await handleMcp(req,ctx);
      expect([202,400]).toContain(response.status);await response.text();
    }
    expect(probes.write).not.toHaveBeenCalled();
    const actualRequest=await handleMcp(modern('tools/call',{name:'protocol_write_probe',arguments:{}}),ctx);
    expect(actualRequest.status).toBe(200);expect((await body(actualRequest)).result.isError).not.toBe(true);
    expect(probes.write).toHaveBeenCalledTimes(1);
  });

  it('bounds request bytes before any tool is invoked',async()=>{
    const oversized=request(rpc('tools/call',{name:'protocol_write_probe',arguments:{text:'x'.repeat(MCP_MAX_REQUEST_BYTES)}}));
    const response=await handleMcp(oversized,ctx);
    expect(response.status).toBe(413);expect((await body(response)).error).toBeDefined();expect(probes.write).not.toHaveBeenCalled();
  });
});
