const clientsByRuntime=new WeakMap();

/** Track before connect so a failed handshake is still closed before its Worker disappears. */
export function registerMcpClient(runtime,client){
  let clients=clientsByRuntime.get(runtime);if(!clients){clients=[];clientsByRuntime.set(runtime,clients);}
  clients.push(client);return client;
}

/** Client.close aborts transport streams; preserve a live Worker until every client has closed. */
export async function disposeOwnerRuntime(runtime){
  const clients=clientsByRuntime.get(runtime)??[];clientsByRuntime.delete(runtime);
  try{
    const results=await Promise.allSettled(clients.map(client=>client.close()));
    const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  }finally{await runtime.mf.dispose();}
}
