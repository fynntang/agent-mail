import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseJsonc} from './sync-svelte-config.mjs';
import {CloudflareClient} from './deploy/cloudflare.mjs';
import {assertTemplate,validateDeploymentInput,requireDeployableInput,makeRuntimeConfig,DeploymentError} from './deploy/plan.mjs';
import {packageRunner} from './deploy/run.mjs';

const placeholder=value=>!value||/CHANGE_ME|(?:^|[.@/])example\.(?:com|net|org)(?:[/:]|$)|\.example(?:[/:]|$)/i.test(value);
/** Deploy-button resources are provisioned by Cloudflare, never created a second time here. */
export async function deployWorkersBuilds({root=process.cwd(),environment=process.env,run,client,log=console.log}={}){
  if(environment.WORKERS_CI!=='1')throw new DeploymentError('workers_builds_only');
  const configPath=join(resolve(root),'wrangler.jsonc');
  if((await lstat(configPath)).isSymbolicLink())throw new DeploymentError('deployment_symlink');
  const template=parseJsonc(await readFile(configPath,'utf8'));assertTemplate(template);
  const vars=template.vars??{},accountId=environment.CLOUDFLARE_ACCOUNT_ID||template.account_id||'';
  if(template.account_id&&template.account_id!==accountId)throw new DeploymentError('deployment_state_mismatch');
  if(environment.AGENT_MAIL_ENABLE_SENDING!==undefined&&!['0','1'].includes(environment.AGENT_MAIL_ENABLE_SENDING))throw new DeploymentError('invalid_deployment_input');
  const team=placeholder(vars.ACCESS_TEAM_DOMAIN)?'':vars.ACCESS_TEAM_DOMAIN,aud=placeholder(vars.ACCESS_AUD)?'':vars.ACCESS_AUD;
  const input=validateDeploymentInput({version:1,accountId,workerName:template.name,
    databaseName:template.d1_databases[0].database_name,bucketName:template.r2_buckets[0].bucket_name,
    mailDomain:vars.MAIL_DOMAIN,ownerEmail:vars.OWNER_EMAIL,
    consoleOrigin:placeholder(vars.CONSOLE_ORIGIN)?'':vars.CONSOLE_ORIGIN,apiOrigin:placeholder(vars.API_ORIGIN)?'':vars.API_ORIGIN,
    accessTeamDomain:team,accessAud:aud,enableSending:environment.AGENT_MAIL_ENABLE_SENDING==='1',
    cimdAllowedHosts:(vars.OAUTH_CIMD_ALLOWED_HOSTS??'').split(',').map(value=>value.trim()).filter(Boolean)},environment);
  requireDeployableInput(input);
  const resources={d1:{id:template.d1_databases[0].database_id,name:input.databaseName},r2:{name:input.bucketName}};
  // Validate provisioned IDs before any API request, build, migration or config mutation.
  makeRuntimeConfig(template,{...input,consoleOrigin:input.consoleOrigin||'https://preflight.invalid',apiOrigin:input.apiOrigin||'https://preflight.invalid'},resources,null);
  if(!client&&!environment.CLOUDFLARE_API_TOKEN)throw new DeploymentError('cloudflare_api_token_required');
  const api=client??new CloudflareClient({accountId,token:environment.CLOUDFLARE_API_TOKEN});
  const subdomain=input.consoleOrigin&&input.apiOrigin?null:await api.workersSubdomain();
  const runtime=makeRuntimeConfig(template,input,resources,subdomain);
  await writeFile(configPath,JSON.stringify(runtime,null,2)+'\n');
  const execute=run??packageRunner({root:resolve(root),environment:{...environment,CLOUDFLARE_ACCOUNT_ID:accountId},log});
  await execute(['run','check']);
  await execute(['run','build:worker']);
  await execute(['exec','wrangler','d1','migrations','apply','DB','--remote','--config','wrangler.jsonc'],{authenticated:true});
  await execute(['exec','wrangler','deploy','--config','wrangler.jsonc'],{authenticated:true});
  return {mode:'workers-builds',workerName:runtime.name,setupUrl:`${runtime.vars.CONSOLE_ORIGIN}/setup`,
    ownerSetupUrl:`${runtime.vars.CONSOLE_ORIGIN}/owner/setup`,sendingEnabled:input.enableSending};
}

export async function runWorkersBuilds(){
  try{console.log(JSON.stringify(await deployWorkersBuilds(),null,2));}
  catch(error){const code=typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'workers_builds_deployment_failed';
    console.error(JSON.stringify({error:code,message:'Check provisioned DB/R2 bindings, account ID, MAIL_DOMAIN and OWNER_EMAIL in Workers Builds. Configure Access and email services through /setup after deployment.'}));process.exitCode=1;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await runWorkersBuilds();
