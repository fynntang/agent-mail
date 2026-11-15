import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

/** Read-only smoke example. Requires the project's dev dependencies; never submits mail. */
async function main() {
  const address=process.env.AGENT_MAIL_URL,token=process.env.AGENT_MAIL_TOKEN;
  if(!address||!token) throw new Error('Set AGENT_MAIL_URL and AGENT_MAIL_TOKEN');
  const url=new URL(address);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||url.pathname!=='/mcp') {
    throw new Error('Use an HTTPS /mcp endpoint, or HTTP on loopback for local testing');
  }
  const client=new Client({name:'agent-mail-smoke',version:'0.1.0'},{versionNegotiation:{mode:'auto'}});
  try {
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}),{timeout:10_000});
    const {tools}=await client.listTools();
    console.log(JSON.stringify({tools:tools.map(tool=>tool.name)},null,2));
    if(tools.some(tool=>tool.name==='get_mailbox')) {
      const result=await client.callTool({name:'get_mailbox',arguments:{}},{timeout:10_000});
      console.log(JSON.stringify(result.structuredContent,null,2));
      if(result.isError) process.exitCode=1;
    }
  }finally {await client.close();}
}

main().catch(()=>{
  // SDK/network errors may contain HTTP details; never print credentials or request headers.
  console.error('MCP check failed. Verify AGENT_MAIL_URL (/mcp), AGENT_MAIL_TOKEN, connectivity and granted scopes.');
  process.exitCode=1;
});
