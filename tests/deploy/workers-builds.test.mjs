import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {deployWorkersBuilds} from '../../scripts/deploy-workers-builds.mjs';
import {parseJsonc} from '../../scripts/sync-svelte-config.mjs';

const environment={WORKERS_CI:'1',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)};
async function fixture(t,modify=()=>{}){
  const root=await mkdtemp(join(tmpdir(),'agent-mail-workers-builds-'));
  t.after(async()=>{if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('agent-mail-workers-builds-'))throw Error('Unsafe fixture cleanup');await rm(root,{recursive:true,force:true});});
  const config=parseJsonc(await readFile('wrangler.jsonc','utf8'));config.name='personal-inbox';config.d1_databases[0].database_id='12345678-1234-4234-8234-123456789abc';
  config.vars.MAIL_DOMAIN='agent.acme.tld';config.vars.OWNER_EMAIL='owner@acme.tld';modify(config);
  await writeFile(join(root,'wrangler.jsonc'),JSON.stringify(config));return{root,config};
}
test('Workers Builds adopts provisioned resources, rebuilds, migrates by binding and deploys exactly one Worker',async t=>{
  const {root}=await fixture(t),calls=[],apiCalls=[];
  const result=await deployWorkersBuilds({root,environment,client:{workersSubdomain:async()=>{apiCalls.push('subdomain');return 'mail-owner';}},run:async(args,options)=>calls.push({args,authenticated:options?.authenticated??false})});
  assert.equal(result.setupUrl,'https://personal-inbox.mail-owner.workers.dev/setup');assert.equal(result.sendingEnabled,false);assert.deepEqual(apiCalls,['subdomain']);
  assert.deepEqual(calls,[{args:['run','check'],authenticated:false},{args:['run','build:worker'],authenticated:false},
    {args:['exec','wrangler','d1','migrations','apply','DB','--remote','--config','wrangler.jsonc'],authenticated:true},
    {args:['exec','wrangler','deploy','--config','wrangler.jsonc'],authenticated:true}]);
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'));assert.equal(config.d1_databases[0].database_id,'12345678-1234-4234-8234-123456789abc');assert.equal(config.r2_buckets[0].binding,'MAIL_BLOBS');
  assert.equal(config.send_email,undefined);assert.equal(config.vars.ACCESS_AUD,'CHANGE_ME');assert.equal(config.vars.OWNER_EMAIL,'owner@acme.tld');assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
});
test('explicit origins avoid an account subdomain query and sending needs an explicit opt-in',async t=>{
  const {root}=await fixture(t,c=>{c.vars.CONSOLE_ORIGIN='https://console.acme.tld';c.vars.API_ORIGIN='https://api.acme.tld';});
  const result=await deployWorkersBuilds({root,environment:{...environment,AGENT_MAIL_ENABLE_SENDING:'1'},client:{workersSubdomain:async()=>{throw Error('must not query');}},run:async()=>{}});
  assert.equal(result.setupUrl,'https://console.acme.tld/setup');assert.equal(result.sendingEnabled,true);assert.deepEqual(JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8')).send_email,[{name:'EMAIL'}]);
});
test('Workers Builds refuses an unprovisioned database before calls or config changes',async t=>{
  const {root}=await fixture(t,c=>{c.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000';}),before=await readFile(join(root,'wrangler.jsonc'),'utf8');let touched=false;
  await assert.rejects(deployWorkersBuilds({root,environment,client:{workersSubdomain:async()=>{touched=true;}},run:async()=>{touched=true;}}),{code:'resource_identity_mismatch'});
  assert.equal(touched,false);assert.equal(await readFile(join(root,'wrangler.jsonc'),'utf8'),before);
});
test('ordinary CI does not authorize the button deployment path',async t=>{
  const {root}=await fixture(t);await assert.rejects(deployWorkersBuilds({root,environment:{...environment,WORKERS_CI:undefined,CI:'true'}}),{code:'workers_builds_only'});
});
test('account mismatch, placeholder owner and management vars fail before deployment',async t=>{
  for(const [modify,code] of [[c=>{c.account_id='b'.repeat(32);},'deployment_state_mismatch'],[c=>{c.vars.OWNER_EMAIL='owner@example.com';},'deployment_placeholders_remaining'],[c=>{c.vars.CLOUDFLARE_API_TOKEN='PRIVATE_MANAGEMENT_TOKEN';},'management_credentials_in_runtime_config']]){
    const {root}=await fixture(t,modify);await assert.rejects(deployWorkersBuilds({root,environment,run:async()=>{throw Error('must not execute');}}),{code});
  }
});
test('a failed migration never uploads a Worker',async t=>{
  const {root}=await fixture(t),calls=[];
  await assert.rejects(deployWorkersBuilds({root,environment,client:{workersSubdomain:async()=> 'mail-owner'},run:async args=>{calls.push(args);if(args.includes('migrations'))throw Error('fixture migration failed');}}),/fixture migration failed/);
  assert.equal(calls.length,3);assert.ok(!calls.some(args=>args[0]==='exec'&&args.includes('deploy')));
});
test('required build credentials and invalid sending values fail closed',async t=>{
  const {root}=await fixture(t);await assert.rejects(deployWorkersBuilds({root,environment}),{code:'cloudflare_api_token_required'});
  await assert.rejects(deployWorkersBuilds({root,environment:{...environment,AGENT_MAIL_ENABLE_SENDING:'yes'}}),{code:'invalid_deployment_input'});
});

test('the package deployment entry preserves a local offline plan even in ordinary CI',async t=>{
  const {root,config}=await fixture(t),path=join(root,'deploy.config.json');
  await writeFile(path,JSON.stringify({version:1,accountId:environment.CLOUDFLARE_ACCOUNT_ID,workerName:config.name,databaseName:config.d1_databases[0].database_name,bucketName:config.r2_buckets[0].bucket_name,mailDomain:'agent.acme.tld',ownerEmail:'owner@acme.tld'}));
  const before=await readFile(join(root,'wrangler.jsonc'),'utf8'),entry=fileURLToPath(new URL('../../scripts/deploy-entry.mjs',import.meta.url));
  const child=spawnSync(process.execPath,[entry,'--input',path],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,CI:'true',WORKERS_CI:'',CLOUDFLARE_API_TOKEN:'PRIVATE_BUTTON_TOKEN'}});
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).mode,'plan');assert.equal(child.stdout.includes('PRIVATE_BUTTON_TOKEN'),false);assert.equal(await readFile(join(root,'wrangler.jsonc'),'utf8'),before);
});
test('the explicit Workers CI entry reports invalid provisioned resources without credentials or remote effects',async t=>{
  const {root}=await fixture(t,c=>{c.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000';}),before=await readFile(join(root,'wrangler.jsonc'),'utf8'),entry=fileURLToPath(new URL('../../scripts/deploy-entry.mjs',import.meta.url));
  const child=spawnSync(process.execPath,[entry],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,...environment,CLOUDFLARE_API_TOKEN:'PRIVATE_BUTTON_TOKEN'}});
  assert.equal(child.status,1);assert.equal(JSON.parse(child.stderr.trim()).error,'resource_identity_mismatch');assert.equal(child.stderr.includes('PRIVATE_BUTTON_TOKEN'),false);assert.equal(await readFile(join(root,'wrangler.jsonc'),'utf8'),before);
});

test('the button secret template cannot override public Owner/origin vars with local development defaults',async()=>{
  const discovered=await readFile('.dev.vars.example','utf8'),local=await readFile('.dev.vars.local.example','utf8');
  const keys=discovered.split(/\r?\n/).filter(line=>!/^\s*(?:#|$)/.test(line)).map(line=>line.split('=')[0].trim());
  for(const key of ['OWNER_EMAIL','CONSOLE_ORIGIN','API_ORIGIN','MAIL_DOMAIN','ACCESS_TEAM_DOMAIN','ACCESS_AUD'])assert.equal(keys.includes(key),false,key);
  assert.match(local,/CONSOLE_ORIGIN="http:\/\/127\.0\.0\.1:8787"/);assert.match(local,/OWNER_EMAIL=/);
});
