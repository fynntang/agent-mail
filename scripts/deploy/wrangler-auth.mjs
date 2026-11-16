import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {DeploymentError} from './plan.mjs';

const require=createRequire(import.meta.url);
const MAX_OUTPUT_BYTES=16*1024;
const TIMEOUT_MS=30_000;

export function assertWranglerLoginAllowed(environment){
  // A CI deployment must use its explicitly provisioned API token, never a machine's login.
  if(environment.CI||environment.WORKERS_CI)throw new DeploymentError('wrangler_login_not_allowed');
}

/** Explicit local opt-in only. Invoke the supported CLI; never inspect credential files. */
export async function readWranglerLoginToken({root,environment=process.env,spawnCommand=spawn,
  resolveEntrypoint=()=>require.resolve('wrangler'),timeoutMs=TIMEOUT_MS}={}){
  assertWranglerLoginAllowed(environment);
  const childEnvironment={...environment,CI:'true',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG:'error',
    WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false'};
  let entry;
  try{entry=resolveEntrypoint();}catch{throw new DeploymentError('wrangler_login_unavailable');}
  const output=await new Promise((resolveResult,reject)=>{
    let child;
    try{child=spawnCommand(process.execPath,[entry,'auth','token','--json'],{cwd:resolve(root??process.cwd()),env:childEnvironment,
      shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch{return reject(new DeploymentError('wrangler_login_unavailable'));}
    const chunks=[];let bytes=0,stderrBytes=0,settled=false;
    const finish=(code,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(code){try{child.kill('SIGKILL');}catch{/* The process may already have exited. */}reject(new DeploymentError(code));}
      else resolveResult(value);
    };
    const timer=setTimeout(()=>finish('wrangler_login_timeout'),timeoutMs);
    child.stdout.on('data',chunk=>{
      if(settled)return;const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=value.byteLength;
      if(bytes>MAX_OUTPUT_BYTES)return finish('wrangler_login_response_too_large');chunks.push(value);
    });
    // Credential commands can include sensitive diagnostics: drain, bound and discard stderr.
    child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderrBytes>MAX_OUTPUT_BYTES)finish('wrangler_login_response_too_large');});
    child.once('error',()=>finish('wrangler_login_unavailable'));
    child.once('close',code=>{if(code!==0)return finish('wrangler_login_unavailable');finish(null,Buffer.concat(chunks));});
  });
  let data;
  try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(output));}
  catch{throw new DeploymentError('wrangler_login_invalid_response');}
  if(data?.type==='api_key')throw new DeploymentError('wrangler_login_unsupported_credentials');
  if(!data||typeof data!=='object'||Array.isArray(data)||!['oauth','api_token'].includes(data.type)
    ||Object.keys(data).some(key=>!['type','token'].includes(key))||typeof data.token!=='string'||!data.token.length
    ||data.token.length>8192||/[\s\x00-\x1f\x7f]/.test(data.token))throw new DeploymentError('wrangler_login_invalid_response');
  return data.token;
}
