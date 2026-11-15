import {createAdapterConfig,requiredCompatibilityFlags} from '../sync-svelte-config.mjs';

export class DeploymentError extends Error {
  constructor(code){super(code);this.code=code;}
}
function invalid(){throw new DeploymentError('invalid_deployment_input');}
function hostname(value){
  return typeof value==='string'&&value.length<=253&&value.includes('.')&&value===value.toLowerCase()
    &&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
function origin(value){
  if(value==='')return value;
  try{const url=new URL(value);if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)invalid();return url.origin;}catch{invalid();}
}
export function validateDeploymentInput(input,environment={}){
  const keys=['version','accountId','workerName','databaseName','bucketName','mailDomain','ownerEmail','consoleOrigin','apiOrigin','accessTeamDomain','accessAud','enableSending','cimdAllowedHosts'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key))||input.version!==1)invalid();
  const value={...input,accountId:input.accountId||environment.CLOUDFLARE_ACCOUNT_ID||'',consoleOrigin:input.consoleOrigin??'',apiOrigin:input.apiOrigin??'',
    accessTeamDomain:input.accessTeamDomain??'',accessAud:input.accessAud??'',enableSending:input.enableSending??false,cimdAllowedHosts:input.cimdAllowedHosts??[]};
  if(['accountId','workerName','databaseName','bucketName','mailDomain','ownerEmail','consoleOrigin','apiOrigin','accessTeamDomain','accessAud'].some(key=>typeof value[key]!=='string'))invalid();
  if(!/^[a-f0-9]{32}$/.test(value.accountId)||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.workerName)
    ||!/^[a-z0-9][a-z0-9_-]{2,62}$/.test(value.databaseName)||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.bucketName)
    ||/^\d+\.\d+\.\d+\.\d+$/.test(value.bucketName)||!hostname(value.mailDomain)||typeof value.ownerEmail!=='string'
    ||value.ownerEmail.length>254||/[\s\x00-\x1f\x7f]/.test(value.ownerEmail)||!/^[-A-Za-z0-9.!#$%&'*+/=?^_`{|}~]{1,64}@[^@]+$/.test(value.ownerEmail)
    ||!hostname(value.ownerEmail.split('@')[1])||typeof value.enableSending!=='boolean')invalid();
  value.consoleOrigin=origin(value.consoleOrigin);value.apiOrigin=origin(value.apiOrigin);
  if(value.accessTeamDomain&&!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(value.accessTeamDomain))invalid();
  if(typeof value.accessAud!=='string'||value.accessAud.length>512||/[\x00-\x20\x7f]/.test(value.accessAud)||Boolean(value.accessTeamDomain)!==Boolean(value.accessAud))invalid();
  if(!Array.isArray(value.cimdAllowedHosts)||value.cimdAllowedHosts.length>20||value.cimdAllowedHosts.some(host=>!hostname(host)||/^[\d.]+$/.test(host)||host.endsWith('.local')||host.endsWith('.localhost')))invalid();
  value.cimdAllowedHosts=[...new Set(value.cimdAllowedHosts)];
  return value;
}
export function requireDeployableInput(input){
  if(/^0+$/.test(input.accountId)||[input.mailDomain,input.ownerEmail,input.consoleOrigin,input.apiOrigin,input.accessTeamDomain,input.accessAud]
    .some(value=>/CHANGE_ME|your[-.]domain|(?:^|[.@/])example\.(?:com|net|org)(?:[/:]|$)|\.example(?:[/:]|$)/i.test(value))) {
    throw new DeploymentError('deployment_placeholders_remaining');
  }
}
export function assertTemplate(template){
  // Older checked-out configs are upgraded before writing/building; explicit private-origin routing is never adopted.
  createAdapterConfig({...template,compatibility_flags:requiredCompatibilityFlags(template.compatibility_flags)});
  if(template.build||template.addresses!==undefined||template.env||template.service||template.legacy_env||template.dispatch_namespaces
    ||template.d1_databases?.length!==1||template.d1_databases[0].binding!=='DB'||template.r2_buckets?.length!==1||template.r2_buckets[0].binding!=='MAIL_BLOBS') {
    throw new DeploymentError('unsupported_deployment_template');
  }
  if(template.queues){
    const queues=template.queues,consumer=queues.consumers?.[0],vars=template.vars??{};
    if(Object.keys(queues).some(key=>key!=='consumers')||queues.consumers?.length!==1||!consumer
      ||consumer.queue!==vars.EMAIL_EVENT_QUEUE||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(consumer.queue)
      ||!['EMAIL_EVENT_ACCOUNT_ID','EMAIL_EVENT_ZONE_ID'].every(key=>/^[a-f0-9]{32}$/.test(vars[key]??''))
      ||!/^[a-f0-9]{32}$/.test(vars.EMAIL_EVENT_SUBSCRIPTION_ID??'')||!hostname(vars.EMAIL_EVENT_DOMAIN))
      throw new DeploymentError('unsupported_deployment_template');
  }
  if(Object.keys(template.vars??{}).some(key=>/^(?:EMAIL_EVENT_BRIDGE_SECRET|EMAIL_SUPPRESSIONS_API_TOKEN)$/i.test(key)))throw new DeploymentError('runtime_secret_in_vars');
  const forbidden=/^(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_KEY|CLOUDFLARE_EMAIL|CF_EMAIL)$/i;
  if(Object.keys(template.vars??{}).some(key=>forbidden.test(key)))throw new DeploymentError('management_credentials_in_runtime_config');
}
export function deploymentPlan(input,{reuseExisting=false}={}){
  return {mode:'plan',accountId:input.accountId,workerName:input.workerName,
    resources:{d1:input.databaseName,r2:input.bucketName},reuseExisting,
    consoleOrigin:input.consoleOrigin||'derived from account workers.dev subdomain',apiOrigin:input.apiOrigin||'derived from account workers.dev subdomain',
    mailDomain:input.mailDomain,ownerConfigured:Boolean(input.ownerEmail),accessConfigured:Boolean(input.accessTeamDomain&&input.accessAud),sendingEnabled:input.enableSending,
    steps:['verify target account/resources and existing Worker','create or validate D1 and R2; save confirmed identifiers',
      'write actual bindings to wrangler.jsonc; synchronize adapter config','typecheck and build final single Worker (dry-run)',
      'apply ordered D1 migrations through DB binding','deploy exactly one Worker','open /setup; configure Access, email domain, routing and sending']};
}
export function makeRuntimeConfig(template,input,resources,workersSubdomain){
  assertTemplate(template);
  if(template.queues&&template.vars.EMAIL_EVENT_ACCOUNT_ID!==input.accountId)throw new DeploymentError('event_account_mismatch');
  if(template.vars?.EMAIL_SUPPRESSIONS_ACCOUNT_ID&&template.vars.EMAIL_SUPPRESSIONS_ACCOUNT_ID!==input.accountId)throw new DeploymentError('suppression_account_mismatch');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resources.d1.id)
    ||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(resources.d1.id)
    ||resources.d1.name!==input.databaseName||resources.r2.name!==input.bucketName)throw new DeploymentError('resource_identity_mismatch');
  let fallback='';
  if(!input.consoleOrigin||!input.apiOrigin){
    if(typeof workersSubdomain!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersSubdomain))throw new DeploymentError('workers_subdomain_unavailable');
    fallback=`https://${input.workerName}.${workersSubdomain}.workers.dev`;
  }
  const config=structuredClone(template);
  config.compatibility_flags=requiredCompatibilityFlags(template.compatibility_flags);
  if(fallback)config.workers_dev=true;
  config.name=input.workerName;config.account_id=input.accountId;
  config.d1_databases=[{binding:'DB',database_name:resources.d1.name,database_id:resources.d1.id,migrations_dir:'migrations'}];
  config.r2_buckets=[{binding:'MAIL_BLOBS',bucket_name:resources.r2.name}];
  config.vars={...config.vars,MAIL_DOMAIN:input.mailDomain,OWNER_EMAIL:input.ownerEmail,CONSOLE_ORIGIN:input.consoleOrigin||fallback,API_ORIGIN:input.apiOrigin||fallback,
    ACCESS_TEAM_DOMAIN:input.accessTeamDomain||'https://CHANGE_ME.cloudflareaccess.com',ACCESS_AUD:input.accessAud||'CHANGE_ME',OAUTH_CIMD_ALLOWED_HOSTS:input.cimdAllowedHosts.join(',')};
  if(input.enableSending)config.send_email=[{name:'EMAIL'}];else delete config.send_email;
  // Domain routes already deliberately configured by the deployer are preserved. Email routes are never synthesized.
  return config;
}
