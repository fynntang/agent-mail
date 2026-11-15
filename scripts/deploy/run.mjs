import {readFile,writeFile,mkdir,lstat,open,rename,unlink} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,extname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {parseJsonc,syncConfig} from '../sync-svelte-config.mjs';
import {DeploymentError,assertTemplate,requireDeployableInput,makeRuntimeConfig,deploymentPlan,validateDeploymentInput} from './plan.mjs';
import {CloudflareClient} from './cloudflare.mjs';

function confined(root,path){const target=resolve(root,path),part=relative(root,target);if(part.startsWith('..')||isAbsolute(part))throw new DeploymentError('unsafe_deployment_path');return target;}
async function rejectSymlink(path){try{if((await lstat(path)).isSymbolicLink())throw new DeploymentError('unsafe_deployment_path');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function atomicJson(path,value){
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(temporary,path);}
  finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function credentialFreeEnvironment(environment){
  const result={...environment};
  for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CF_API_TOKEN','CF_API_KEY','CF_EMAIL','EMAIL_SUPPRESSIONS_API_TOKEN'])delete result[key];
  return result;
}
export function packageRunner({root,environment=process.env,log=console.log}){
  const cli=environment.npm_execpath;
  const supported=typeof cli==='string'&&isAbsolute(cli)&&/^pnpm\.(?:js|cjs|mjs|exe)$/i.test(basename(cli));
  const commands=new Set([
    ['run','check'],['run','build:worker'],
    ['exec','wrangler','d1','migrations','apply','DB','--remote','--config','wrangler.jsonc'],
    ['exec','wrangler','deploy','--config','wrangler.jsonc']
  ].map(args=>JSON.stringify(args)));
  return async(args,{authenticated=false}={})=>{
    if(!commands.has(JSON.stringify(args)))throw new DeploymentError('unsupported_deployment_command');
    if(cli&&!supported)throw new DeploymentError('pnpm_required');
    const secrets=[environment.CLOUDFLARE_API_TOKEN,environment.CLOUDFLARE_API_KEY,environment.CF_API_TOKEN,environment.CF_API_KEY,environment.CLOUDFLARE_EMAIL,environment.CF_EMAIL,environment.EMAIL_SUPPRESSIONS_API_TOKEN].filter(Boolean);
    // Fallback on Windows uses only the closed, server-owned commands above; no input/path is interpolated.
    const executable=supported?(extname(cli).toLowerCase()==='.exe'?cli:process.execPath):process.platform==='win32'?(environment.ComSpec??'C:\\Windows\\System32\\cmd.exe'):'pnpm';
    const argv=supported?(executable===cli?args:[cli,...args]):process.platform==='win32'?['/d','/s','/c',`pnpm ${args.join(' ')}`]:args;
    const childEnvironment={...(authenticated?environment:credentialFreeEnvironment(environment))};
    // A runtime suppression credential is never a deployment credential, even for authenticated commands.
    delete childEnvironment.EMAIL_SUPPRESSIONS_API_TOKEN;
    await new Promise((resolveRun,reject)=>{
      const child=spawn(executable,argv,{cwd:root,env:childEnvironment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const print=stream=>{let buffer='';stream.setEncoding('utf8');stream.on('data',chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))>=0){let line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);for(const secret of secrets)line=line.replaceAll(secret,'[REDACTED]');log(line);}});stream.on('end',()=>{if(buffer){for(const secret of secrets)buffer=buffer.replaceAll(secret,'[REDACTED]');log(buffer);}});};
      print(child.stdout);print(child.stderr);
      child.once('error',()=>reject(new DeploymentError('deployment_command_failed')));
      child.once('close',code=>code===0?resolveRun():reject(new DeploymentError('deployment_command_failed')));
    });
  };
}
export async function deployProject({root=process.cwd(),input,apply=false,reuseExisting=false,environment=process.env,client,run,log=console.log}={}){
  root=resolve(root);input=validateDeploymentInput(input,environment);
  const configPath=confined(root,'wrangler.jsonc');await rejectSymlink(configPath);
  const original=await readFile(configPath,'utf8'),template=parseJsonc(original);assertTemplate(template);
  const plan=deploymentPlan(input,{reuseExisting});
  if(!apply)return plan; // No cloud calls, progress writes, commands or credential requirements for a plan.
  requireDeployableInput(input);
  if(!client&&!environment.CLOUDFLARE_API_TOKEN)throw new DeploymentError('cloudflare_api_token_required');
  const execute=run??packageRunner({root,environment:{...environment,CLOUDFLARE_ACCOUNT_ID:input.accountId},log});
  const api=client??new CloudflareClient({accountId:input.accountId,token:environment.CLOUDFLARE_API_TOKEN});
  const directory=confined(root,'.agent-mail');await rejectSymlink(directory);await mkdir(directory,{recursive:true});
  const statePath=join(directory,'deploy-state.json'),lockPath=join(directory,'deploy.lock');await rejectSymlink(statePath);await rejectSymlink(lockPath);
  let lock;
  try{lock=await open(lockPath,'wx');}catch(error){if(error.code==='EEXIST')throw new DeploymentError('deployment_in_progress');throw error;}
  try{
    let state;
    try{
      state=JSON.parse(await readFile(statePath,'utf8'));
      if(!state||typeof state!=='object'||Array.isArray(state))throw new DeploymentError('invalid_deployment_state');
    }catch(error){if(error.code!=='ENOENT')throw new DeploymentError('invalid_deployment_state');}
    if(state&&(state.version!==1||state.accountId!==input.accountId||state.workerName!==input.workerName
      ||state.databaseName!==input.databaseName||state.bucketName!==input.bucketName))throw new DeploymentError('deployment_state_mismatch');
    if(state&&(state.deployed!==undefined&&typeof state.deployed!=='boolean'||!state.resources||typeof state.resources!=='object'||Array.isArray(state.resources)
      ||state.resources.d1!==undefined&&(!state.resources.d1||typeof state.resources.d1!=='object'||Array.isArray(state.resources.d1)
        ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(state.resources.d1.id)
        ||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(state.resources.d1.id)||state.resources.d1.name!==input.databaseName)
      ||state.resources.r2!==undefined&&(!state.resources.r2||typeof state.resources.r2!=='object'||Array.isArray(state.resources.r2)||state.resources.r2.name!==input.bucketName)))throw new DeploymentError('invalid_deployment_state');
    state??={version:1,accountId:input.accountId,workerName:input.workerName,databaseName:input.databaseName,bucketName:input.bucketName,resources:{},startedAt:Date.now()};
    const checkpoint=async(step)=>{state.lastStep=step;state.updatedAt=Date.now();await atomicJson(statePath,state);};
    // Verify every existing target before creating anything. Name equality alone does not establish ownership.
    const [d1,r2,workerExists]=await Promise.all([
      state.resources.d1?api.getD1(state.resources.d1.id):api.findD1(input.databaseName),
      state.resources.r2?api.getR2(state.resources.r2.name):api.findR2(input.bucketName),api.workerExists(input.workerName)
    ]);
    if(state.resources.d1&&(!d1||d1.id!==state.resources.d1.id||d1.name!==input.databaseName))throw new DeploymentError('recorded_d1_missing_or_changed');
    if(state.resources.r2&&(!r2||r2.name!==input.bucketName))throw new DeploymentError('recorded_r2_missing_or_changed');
    if((d1&&!state.resources.d1||r2&&!state.resources.r2||workerExists&&!state.deployed)&&!reuseExisting)throw new DeploymentError('existing_resources_require_reuse');
    if(d1&&d1.name!==input.databaseName||r2&&r2.name!==input.bucketName)throw new DeploymentError('resource_identity_mismatch');
    let subdomain=null;
    if(!input.consoleOrigin||!input.apiOrigin){
      try{subdomain=await api.workersSubdomain();}catch{throw new DeploymentError('workers_subdomain_required');}
    }
    await checkpoint('preflight');
    state.resources.d1=d1??await api.createD1(input.databaseName);await checkpoint('d1_resolved');
    state.resources.r2=r2??await api.createR2(input.bucketName);await checkpoint('r2_resolved');
    const runtime=makeRuntimeConfig(template,input,state.resources,subdomain);
    const backup=join(directory,'wrangler.before-deploy.jsonc');
    try{await writeFile(backup,original,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
    await atomicJson(configPath,runtime);
    await syncConfig(configPath,confined(root,'wrangler.svelte.jsonc'));
    await checkpoint('configured');
    await execute(['run','check']);
    await execute(['run','build:worker']);await checkpoint('built');
    await execute(['exec','wrangler','d1','migrations','apply','DB','--remote','--config','wrangler.jsonc'],{authenticated:true});await checkpoint('migrated');
    await execute(['exec','wrangler','deploy','--config','wrangler.jsonc'],{authenticated:true});state.deployed=true;await checkpoint('deployed');
    return {...plan,mode:'applied',resources:state.resources,consoleOrigin:runtime.vars.CONSOLE_ORIGIN,apiOrigin:runtime.vars.API_ORIGIN,
      setupUrl:`${runtime.vars.CONSOLE_ORIGIN}/setup`,ownerSetupUrl:`${runtime.vars.CONSOLE_ORIGIN}/owner/setup`,accessConfigured:Boolean(input.accessTeamDomain),
      note:'Storage and application deployed. Configure/verify domains, Access, Email Routing and Sending in the Owner wizard; no email or DNS settings were changed.'};
  }finally{await lock.close();await unlink(lockPath);}
}
