import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {deployProject} from './deploy/run.mjs';
import {CloudflareError} from './deploy/cloudflare.mjs';

try{
  const {values}=parseArgs({args:process.argv.slice(2).filter(arg=>arg!=='--'),options:{input:{type:'string',default:'deploy.config.json'},apply:{type:'boolean',default:false},'reuse-existing':{type:'boolean',default:false},help:{type:'boolean',default:false}}});
  if(values.help)console.log('pnpm deploy:plan -- --input deploy.config.json\npnpm deploy:setup -- --input deploy.config.json [--reuse-existing]\nDefault: offline plan. --apply creates cloud resources, migrates D1 and deploys one Worker.');
  else{
    const input=JSON.parse(await readFile(values.input,'utf8'));
    const result=await deployProject({input,apply:values.apply,reuseExisting:values['reuse-existing']});
    console.log(JSON.stringify(result,null,2));
  }
}catch(error){
  const code=typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'deployment_failed';
  const hints={
    workers_subdomain_required:'Enable a workers.dev subdomain in your Cloudflare account (Workers onboarding), and check API token read permissions; or supply both attached HTTPS origins.',
    existing_resources_require_reuse:'Verify the target account and existing Worker/D1/R2 names, then use --reuse-existing only if they belong to this instance.',
    deployment_placeholders_remaining:'Replace the example account, domains and Owner values before applying.',
    cloudflare_api_token_required:'Provide CLOUDFLARE_API_TOKEN through your local terminal or CI secret, never the Worker.',
    pnpm_required:'Run this installer with pnpm 11.25.0. Other package managers can parse Wrangler arguments differently.',
    deployment_in_progress:'A deployment lock exists. Confirm the other process has stopped before removing only .agent-mail/deploy.lock.'
  };
  console.error(JSON.stringify({error:code,message:hints[code]??'Check the input, Cloudflare permissions and .agent-mail deployment progress. No resources are automatically deleted.',
    ...(error instanceof CloudflareError?{operation:error.operation,status:error.status,apiCodes:error.apiCodes}: {})}));
  process.exitCode=1;
}
