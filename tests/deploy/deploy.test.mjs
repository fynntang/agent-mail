import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deployProject, packageRunner } from '../../scripts/deploy/run.mjs';
import { validateDeploymentInput, requireDeployableInput, makeRuntimeConfig } from '../../scripts/deploy/plan.mjs';
import { parseJsonc, HTTP_ENTRY, RUNTIME_ENTRY, createAdapterConfig, REQUIRED_COMPATIBILITY_FLAGS } from '../../scripts/sync-svelte-config.mjs';

const ACCOUNT = 'a'.repeat(32);
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'deployment-test-api-secret';
const CHECK = ['run', 'check'];
const BUILD = ['run', 'build:worker'];
const MIGRATE = ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.jsonc'];
const UPLOAD = ['exec', 'wrangler', 'deploy', '--config', 'wrangler.jsonc'];
const CREDENTIAL_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL'];
const input = {
  version: 1, accountId: ACCOUNT, workerName: 'personal-agent-mail', databaseName: 'personal-agent-mail-db', bucketName: 'personal-agent-mail-blobs',
  mailDomain: 'mail.agentmail.test', ownerEmail: 'owner@agentmail.test', consoleOrigin: 'https://console.agentmail.test', apiOrigin: 'https://api.agentmail.test',
  accessTeamDomain: 'https://agentmail.cloudflareaccess.com', accessAud: 'b'.repeat(64), enableSending: false, cimdAllowedHosts: []
};
const template = {
  name: 'agent-mail-personal', main: RUNTIME_ENTRY, compatibility_date: '2026-11-10',
  assets: { directory: '.svelte-kit/cloudflare', binding: 'ASSETS', run_worker_first: true },
  d1_databases: [{ binding: 'DB', database_name: 'agent-mail-personal', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'MAIL_BLOBS', bucket_name: 'agent-mail-personal' }], send_email: [{ name: 'EMAIL' }], triggers: { crons: ['* * * * *'] },
  vars: { MAIL_DOMAIN: 'agent.example.com', OWNER_EMAIL: 'CHANGE_ME', ACCESS_TEAM_DOMAIN: 'https://CHANGE_ME.cloudflareaccess.com', ACCESS_AUD: 'CHANGE_ME' }
};
const expectedD1 = { id: ID, name: input.databaseName };
const expectedR2 = { name: input.bucketName };
const copy = value => structuredClone(value);
const code = expected => error => (assert.equal(error.code, expected), true);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-mail-deploy-'));
  t.after(async () => {
    // The recursive delete is confined to the exact temporary directory this test created.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agent-mail-deploy-'));
    await rm(root, { recursive: true, force: true });
  });
  const original = JSON.stringify(template, null, 2) + '\n';
  await writeFile(join(root, 'wrangler.jsonc'), original);
  return {
    root, original,
    read: async path => JSON.parse(await readFile(join(root, path), 'utf8')),
    state: async () => JSON.parse(await readFile(join(root, '.agent-mail/deploy-state.json'), 'utf8')),
    writeState: async state => {
      await mkdir(join(root, '.agent-mail'), { recursive: true });
      await writeFile(join(root, '.agent-mail/deploy-state.json'), JSON.stringify(state));
    }
  };
}

function fakeCloudflare({ d1 = null, r2 = null, worker = false, failR2Creates = 0 } = {}) {
  const calls = [];
  const record = (method, ...args) => calls.push({ method, args });
  return {
    calls,
    async findD1(name) { record('findD1', name); return copy(d1); },
    async findR2(name) { record('findR2', name); return copy(r2); },
    async getD1(id) { record('getD1', id); return copy(d1); },
    async getR2(name) { record('getR2', name); return copy(r2); },
    async workerExists(name) { record('workerExists', name); return worker; },
    async workersSubdomain() { record('workersSubdomain'); return 'personal-agents'; },
    async createD1(name) { record('createD1', name); d1 = { id: ID, name }; return copy(d1); },
    async createR2(name) {
      record('createR2', name);
      if (failR2Creates-- > 0) throw Object.assign(new Error('simulated R2 failure'), { code: 'simulated_r2_failure' });
      r2 = { name }; return copy(r2);
    }
  };
}

function recordingRunner(f, { failAt } = {}) {
  const calls = [];
  const run = async (args, options = {}) => {
    calls.push({ args: [...args], options: { ...options } });
    const runtime = parseJsonc(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'));
    const adapter = parseJsonc(await readFile(join(f.root, 'wrangler.svelte.jsonc'), 'utf8'));
    assert.equal(runtime.main, RUNTIME_ENTRY);
    assert.equal(adapter.main, HTTP_ENTRY);
    assert.equal(runtime.account_id, ACCOUNT);
    for (const config of [runtime, adapter]) {
      for (const flag of REQUIRED_COMPATIBILITY_FLAGS) assert.ok(config.compatibility_flags.includes(flag));
      assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: input.databaseName, database_id: ID, migrations_dir: 'migrations' }]);
      assert.deepEqual(config.r2_buckets, [{ binding: 'MAIL_BLOBS', bucket_name: input.bucketName }]);
      assert.ok(!JSON.stringify(config).includes(TOKEN));
    }
    assert.equal(adapter.triggers, undefined);
    assert.deepEqual(runtime.triggers, template.triggers);
    if (failAt && JSON.stringify(args) === JSON.stringify(failAt)) throw Object.assign(new Error('simulated command failure'), { code: 'simulated_command_failure' });
  };
  return { run, calls };
}

function state(overrides = {}) {
  return { version: 1, accountId: ACCOUNT, workerName: input.workerName, databaseName: input.databaseName, bucketName: input.bucketName,
    resources: { d1: copy(expectedD1), r2: copy(expectedR2) }, startedAt: 1, ...overrides };
}

test('offline plan needs no credentials and has no cloud, command, state, or config effects', async t => {
  const f = await fixture(t);
  const noCloud = new Proxy({}, { get() { assert.fail('Offline plan touched Cloudflare'); } });
  const result = await deployProject({ root: f.root, input, environment: {}, client: noCloud, run: () => assert.fail('Offline plan ran a command') });
  assert.equal(result.mode, 'plan');
  assert.equal(result.workerName, input.workerName);
  assert.equal(result.resources.d1, input.databaseName);
  assert.ok(!JSON.stringify(result).includes('API_TOKEN'));
  assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
  assert.deepEqual(await readdir(f.root), ['wrangler.jsonc']);
});

test('CLI defaults to an offline plan with no credentials and leaves the fixture unchanged', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'deploy.config.json'), JSON.stringify(input));
  const cli = fileURLToPath(new URL('../../scripts/deploy.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--input', 'deploy.config.json'], { cwd: f.root, env: {}, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'plan');
  assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
  assert.deepEqual((await readdir(f.root)).sort(), ['deploy.config.json', 'wrangler.jsonc']);
});

test('actual resource IDs and synchronized adapter precede every command; upload occurs exactly once after migrations', async t => {
  const f = await fixture(t);
  const client = fakeCloudflare();
  const runner = recordingRunner(f);
  const result = await deployProject({ root: f.root, input, apply: true, client, run: runner.run, environment: { CLOUDFLARE_API_TOKEN: TOKEN } });
  assert.equal(result.mode, 'applied');
  assert.equal(result.ownerSetupUrl, `${input.consoleOrigin}/owner/setup`);
  assert.deepEqual(runner.calls.map(call => call.args), [CHECK, BUILD, MIGRATE, UPLOAD]);
  assert.deepEqual(runner.calls.map(call => call.options.authenticated ?? false), [false, false, true, true]);
  assert.equal(runner.calls.filter(call => JSON.stringify(call.args) === JSON.stringify(UPLOAD)).length, 1);
  assert.equal(client.calls.filter(call => call.method === 'createD1').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'createR2').length, 1);
  assert.ok(!client.calls.some(call => call.method === 'workersSubdomain'));
  const progress = await f.state();
  assert.equal(progress.lastStep, 'deployed');
  assert.equal(progress.deployed, true);
  assert.deepEqual(progress.resources, { d1: expectedD1, r2: expectedR2 });
  assert.ok(!JSON.stringify(progress).includes(TOKEN));
  assert.equal(await readFile(join(f.root, '.agent-mail/wrangler.before-deploy.jsonc'), 'utf8'), f.original);
  assert.ok(!(await readdir(join(f.root, '.agent-mail'))).includes('deploy.lock'));
  assert.equal((await f.read('wrangler.jsonc')).send_email, undefined);
});

test('missing origins derive from the account subdomain while preserving a single Worker deployment', async t => {
  const f = await fixture(t);
  const client = fakeCloudflare();
  const runner = recordingRunner(f);
  const result = await deployProject({ root: f.root, input: { ...input, consoleOrigin: '', apiOrigin: '', enableSending: true }, apply: true, client, run: runner.run, environment: {} });
  const origin = `https://${input.workerName}.personal-agents.workers.dev`;
  assert.equal(result.consoleOrigin, origin);
  assert.equal(result.apiOrigin, origin);
  assert.equal(result.setupUrl, `${origin}/setup`);
  assert.deepEqual((await f.read('wrangler.jsonc')).send_email, [{ name: 'EMAIL' }]);
  assert.equal(client.calls.filter(call => call.method === 'workersSubdomain').length, 1);
  assert.equal(runner.calls.length, 4);
});

test('partial R2 failure checkpoints D1 and resumes without creating D1 again', async t => {
  const f = await fixture(t);
  const client = fakeCloudflare({ failR2Creates: 1 });
  const runner = recordingRunner(f);
  await assert.rejects(deployProject({ root: f.root, input, apply: true, client, run: runner.run, environment: {} }), code('simulated_r2_failure'));
  const partial = await f.state();
  assert.equal(partial.lastStep, 'd1_resolved');
  assert.deepEqual(partial.resources, { d1: expectedD1 });
  assert.equal(runner.calls.length, 0);
  assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
  assert.ok(!(await readdir(join(f.root, '.agent-mail'))).includes('deploy.lock'));
  const result = await deployProject({ root: f.root, input, apply: true, client, run: runner.run, environment: {} });
  assert.equal(result.mode, 'applied');
  assert.equal(client.calls.filter(call => call.method === 'createD1').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'createR2').length, 2);
  assert.equal(client.calls.filter(call => call.method === 'getD1').length, 1);
  assert.equal(runner.calls.length, 4);
});

test('workers.dev onboarding or permission failure stops before creating storage', async t => {
  const f = await fixture(t);
  const client = fakeCloudflare();
  client.workersSubdomain = async () => { throw new Error('account not onboarded'); };
  await assert.rejects(deployProject({ root: f.root, input: { ...input, consoleOrigin: '', apiOrigin: '' }, apply: true,
    client, environment: {}, run: () => assert.fail('Preflight failure ran a command') }), code('workers_subdomain_required'));
  assert.ok(!client.calls.some(call => call.method.startsWith('create')));
  assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
  assert.deepEqual(await readdir(join(f.root, '.agent-mail')), []);
});

test('same-name D1, R2, or Worker needs explicit adoption before any resource is created', async t => {
  for (const existing of [{ d1: expectedD1 }, { r2: expectedR2 }, { worker: true }]) {
    await t.test(Object.keys(existing)[0], async child => {
      const f = await fixture(child);
      const client = fakeCloudflare(existing);
      await assert.rejects(deployProject({ root: f.root, input, apply: true, client, run: () => assert.fail('No commands before adoption'), environment: {} }), code('existing_resources_require_reuse'));
      assert.ok(!client.calls.some(call => call.method.startsWith('create')));
      assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
      assert.deepEqual(await readdir(join(f.root, '.agent-mail')), []);
    });
  }
});

test('explicit adoption validates and reuses existing resources instead of recreating them', async t => {
  const f = await fixture(t);
  const client = fakeCloudflare({ d1: expectedD1, r2: expectedR2, worker: true });
  const runner = recordingRunner(f);
  const result = await deployProject({ root: f.root, input, apply: true, reuseExisting: true, client, run: runner.run, environment: {} });
  assert.equal(result.mode, 'applied');
  assert.ok(!client.calls.some(call => call.method.startsWith('create')));
  assert.deepEqual((await f.state()).resources, { d1: expectedD1, r2: expectedR2 });
});

test('state target mismatches fail before cloud calls, resource creation, or commands', async t => {
  for (const mismatch of [{ accountId: 'c'.repeat(32) }, { workerName: 'different-worker' }, { databaseName: 'different-database' }, { bucketName: 'different-bucket' }, { version: 2 }]) {
    await t.test(Object.keys(mismatch)[0], async child => {
      const f = await fixture(child);
      await f.writeState(state(mismatch));
      const client = fakeCloudflare();
      await assert.rejects(deployProject({ root: f.root, input, apply: true, client, run: () => assert.fail('Mismatched state ran a command'), environment: {} }), code('deployment_state_mismatch'));
      assert.deepEqual(client.calls, []);
      assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
      assert.ok(!(await readdir(join(f.root, '.agent-mail'))).includes('deploy.lock'));
    });
  }
});

test('corrupted journal contents fail before cloud calls and cannot become a fresh deployment', async t => {
  const corrupted = [
    ['null document', null], ['false document', false], ['zero document', 0],
    ['invalid deployed flag', state({ deployed: 'true' })],
    ['missing resources', state({ resources: undefined })], ['null resources', state({ resources: null })],
    ['array resources', state({ resources: [] })], ['string resources', state({ resources: 'bad' })],
    ['malformed D1 record', state({ resources: { d1: {} } })],
    ['invalid D1 UUID', state({ resources: { d1: { id: '-'.repeat(36), name: input.databaseName } } })],
    ['zero D1 UUID', state({ resources: { d1: { id: '00000000-0000-0000-0000-000000000000', name: input.databaseName } } })],
    ['malformed R2 record', state({ resources: { r2: {} } })]
  ];
  for (const [label, value] of corrupted) {
    await t.test(label, async child => {
      const f = await fixture(child);
      await f.writeState(value);
      const before = await readFile(join(f.root, '.agent-mail/deploy-state.json'), 'utf8');
      const client = fakeCloudflare();
      await assert.rejects(deployProject({ root: f.root, input, apply: true, client, run: () => assert.fail('Corrupted state ran a command'), environment: {} }), code('invalid_deployment_state'));
      assert.deepEqual(client.calls, []);
      assert.equal(await readFile(join(f.root, '.agent-mail/deploy-state.json'), 'utf8'), before);
      assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
      assert.ok(!(await readdir(join(f.root, '.agent-mail'))).includes('deploy.lock'));
    });
  }
  await t.test('malformed JSON', async child => {
    const f = await fixture(child);
    await f.writeState(state());
    await writeFile(join(f.root, '.agent-mail/deploy-state.json'), '{invalid-json');
    const client = fakeCloudflare();
    await assert.rejects(deployProject({ root: f.root, input, apply: true, client, environment: {} }), code('invalid_deployment_state'));
    assert.deepEqual(client.calls, []);
  });
});

test('recorded missing D1/R2 resources are never silently recreated or adopted', async t => {
  for (const [existing, expected] of [[{ r2: expectedR2 }, 'recorded_d1_missing_or_changed'], [{ d1: expectedD1 }, 'recorded_r2_missing_or_changed']]) {
    await t.test(expected, async child => {
      const f = await fixture(child);
      await f.writeState(state());
      const client = fakeCloudflare(existing);
      await assert.rejects(deployProject({ root: f.root, input, apply: true, reuseExisting: true, client, run: () => assert.fail('Missing recorded resource ran a command'), environment: {} }), code(expected));
      assert.ok(!client.calls.some(call => call.method.startsWith('create') || call.method.startsWith('find')));
      assert.equal(await readFile(join(f.root, 'wrangler.jsonc'), 'utf8'), f.original);
    });
  }
});

test('check/build failures block migrations and upload; migration failure blocks upload', async t => {
  for (const [failAt, expectedCommands, step] of [[CHECK, [CHECK], 'configured'], [BUILD, [CHECK, BUILD], 'configured'], [MIGRATE, [CHECK, BUILD, MIGRATE], 'built']]) {
    await t.test(failAt.join(' '), async child => {
      const f = await fixture(child);
      const runner = recordingRunner(f, { failAt });
      await assert.rejects(deployProject({ root: f.root, input, apply: true, client: fakeCloudflare(), run: runner.run, environment: {} }), code('simulated_command_failure'));
      assert.deepEqual(runner.calls.map(call => call.args), expectedCommands);
      const progress = await f.state();
      assert.equal(progress.lastStep, step);
      assert.notEqual(progress.deployed, true);
      assert.ok(!(await readdir(join(f.root, '.agent-mail'))).includes('deploy.lock'));
    });
  }
});

test('invalid/placeholder deployment inputs fail without cloud or command effects', async t => {
  const invalid = [
    { version: 2 }, { accountId: 'not-an-account' }, { workerName: '../escape' }, { bucketName: 'UPPERCASE' },
    { mailDomain: 'https://agentmail.test' }, { ownerEmail: 'owner\n@agentmail.test' }, { consoleOrigin: 'http://console.agentmail.test' },
    { apiOrigin: 'https://api.agentmail.test/path' }, { accessTeamDomain: 'https://evil.test' }, { accessAud: '' },
    { cimdAllowedHosts: ['127.0.0.1'] }, { unknownSetting: true }
  ];
  for (const changes of invalid) {
    const f = await fixture(t);
    const client = fakeCloudflare();
    await assert.rejects(deployProject({ root: f.root, input: { ...input, ...changes }, apply: true, client, environment: {}, run: () => assert.fail('Invalid input ran a command') }), code('invalid_deployment_input'));
    assert.equal(client.calls.length, 0);
    assert.deepEqual(await readdir(f.root), ['wrangler.jsonc']);
  }
  for (const changes of [{ accountId: '0'.repeat(32) }, { mailDomain: 'agent.example.com' }, { ownerEmail: 'owner@example.com' }, { accessAud: 'CHANGE_ME' }]) {
    const f = await fixture(t);
    const client = fakeCloudflare();
    await assert.rejects(deployProject({ root: f.root, input: { ...input, ...changes }, apply: true, client, environment: {}, run: () => assert.fail('Placeholders ran a command') }), code('deployment_placeholders_remaining'));
    assert.equal(client.calls.length, 0);
    assert.deepEqual(await readdir(f.root), ['wrangler.jsonc']);
  }
});

test('apply requires a credential when no injected client is supplied and planning can use account env fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(deployProject({ root: f.root, input, apply: true, environment: {} }), code('cloudflare_api_token_required'));
  assert.deepEqual(await readdir(f.root), ['wrangler.jsonc']);
  const normalized = validateDeploymentInput({ ...input, accountId: '' }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  assert.equal(normalized.accountId, ACCOUNT);
  assert.doesNotThrow(() => requireDeployableInput(normalized));
});

test('required resource and Owner names reject missing, undefined, and nonstring values', () => {
  for (const key of ['accountId', 'workerName', 'databaseName', 'bucketName', 'mailDomain', 'ownerEmail']) {
    const missing = { ...input };
    delete missing[key];
    assert.throws(() => validateDeploymentInput(missing, {}), code('invalid_deployment_input'), `Missing ${key}`);
    for (const value of [undefined, null, 1234, {}, ['valid-looking-name']]) {
      assert.throws(() => validateDeploymentInput({ ...input, [key]: value }, {}), code('invalid_deployment_input'), `${key} must be a string`);
    }
  }
});

test('runtime plan retains explicit Worker routes, never synthesizes email routing, and rejects credential vars', () => {
  const routed = { ...copy(template), routes: [{ pattern: 'console.agentmail.test', custom_domain: true }] };
  const runtime = makeRuntimeConfig(routed, input, { d1: expectedD1, r2: expectedR2 }, null);
  assert.deepEqual(runtime.routes, routed.routes);
  assert.equal(runtime.addresses, undefined);
  assert.equal(runtime.main, RUNTIME_ENTRY);
  for (const key of CREDENTIAL_KEYS) {
    const unsafe = { ...copy(template), vars: { [key]: TOKEN } };
    assert.throws(() => makeRuntimeConfig(unsafe, input, { d1: expectedD1, r2: expectedR2 }, null), code('management_credentials_in_runtime_config'));
  }
});

test('deployment upgrades legacy compatibility flags, preserves explicit flags and refuses private-origin routing', () => {
  const custom={...copy(template),compatibility_flags:['nodejs_compat','nodejs_compat_populate_process_env']};
  const runtime=makeRuntimeConfig(custom,input,{d1:expectedD1,r2:expectedR2},null);
  assert.deepEqual(runtime.compatibility_flags,['nodejs_compat','nodejs_compat_populate_process_env','global_fetch_strictly_public']);
  assert.deepEqual(createAdapterConfig(runtime).compatibility_flags,runtime.compatibility_flags);
  assert.deepEqual(custom.compatibility_flags,['nodejs_compat','nodejs_compat_populate_process_env']);
  assert.throws(()=>makeRuntimeConfig({...copy(template),compatibility_flags:['global_fetch_private_origin']},input,{d1:expectedD1,r2:expectedR2},null));
});

test('deployment retains one dedicated Email Sending queue consumer and keeps bridge secrets out of vars',()=>{
  const queues={consumers:[{queue:'email-events',max_batch_size:10,max_retries:8,dead_letter_queue:'email-events-dead'}]};
  const configured={...copy(template),queues,vars:{...template.vars,EMAIL_EVENT_QUEUE:'email-events',EMAIL_EVENT_ACCOUNT_ID:ACCOUNT,
    EMAIL_EVENT_ZONE_ID:'b'.repeat(32),EMAIL_EVENT_SUBSCRIPTION_ID:'c'.repeat(32),EMAIL_EVENT_DOMAIN:'send.agentmail.test'}};
  const runtime=makeRuntimeConfig(configured,input,{d1:expectedD1,r2:expectedR2},null);
  assert.deepEqual(runtime.queues,queues);assert.equal(createAdapterConfig(runtime).queues,undefined);assert.equal(runtime.main,RUNTIME_ENTRY);
  assert.throws(()=>makeRuntimeConfig({...configured,queues:{...queues,producers:[{queue:'email-events',binding:'BAD'}]}},input,{d1:expectedD1,r2:expectedR2},null),code('unsupported_deployment_template'));
  assert.throws(()=>makeRuntimeConfig({...configured,vars:{...configured.vars,EMAIL_EVENT_ACCOUNT_ID:'c'.repeat(32)}},input,{d1:expectedD1,r2:expectedR2},null),code('event_account_mismatch'));
  assert.throws(()=>makeRuntimeConfig({...configured,vars:{...configured.vars,EMAIL_EVENT_BRIDGE_SECRET:'private'}},input,{d1:expectedD1,r2:expectedR2},null),code('runtime_secret_in_vars'));
});

test('provider suppression credentials cannot be ordinary Worker vars or reach deployment subprocesses',async t=>{
  for(const key of ['EMAIL_SUPPRESSIONS_API_TOKEN','email_suppressions_api_token'])
    assert.throws(()=>makeRuntimeConfig({...copy(template),vars:{...template.vars,[key]:'runtime-private-token'}},input,{d1:expectedD1,r2:expectedR2},null),code('runtime_secret_in_vars'));
  assert.throws(()=>makeRuntimeConfig({...copy(template),vars:{...template.vars,EMAIL_SUPPRESSIONS_ACCOUNT_ID:'c'.repeat(32)}},input,{d1:expectedD1,r2:expectedR2},null),code('suppression_account_mismatch'));
  const f=await fixture(t),cli=join(f.root,'pnpm.mjs'),logs=[];
  await writeFile(cli,"console.log(JSON.stringify({runtimeToken:process.env.EMAIL_SUPPRESSIONS_API_TOKEN??null}));\n");
  const run=packageRunner({root:f.root,environment:{npm_execpath:cli,EMAIL_SUPPRESSIONS_API_TOKEN:'runtime-private-token'},log:line=>logs.push(line)});
  for(const command of [CHECK,BUILD])await run(command);
  for(const command of [MIGRATE,UPLOAD])await run(command,{authenticated:true});
  assert.equal(logs.length,4);assert.ok(logs.every(line=>JSON.parse(line).runtimeToken===null));
});

async function fakePackageManager(f) {
  const path = join(f.root, 'pnpm.mjs');
  await writeFile(path, `const keys = ${JSON.stringify(CREDENTIAL_KEYS)};\nconsole.log(JSON.stringify({args:process.argv.slice(2),CI:process.env.CI,retained:process.env.TEST_RETAINED,credentials:Object.fromEntries(keys.map(key=>[key,process.env[key]??null]))}));\n`);
  return path;
}

test('packageRunner only accepts the closed command set and strips management credentials from check/build', async t => {
  const f = await fixture(t);
  const cli = await fakePackageManager(f);
  const logs = [];
  const secrets = Object.fromEntries(CREDENTIAL_KEYS.map((key, i) => [key, `fixture-secret-${i}`]));
  const run = packageRunner({ root: f.root, environment: { ...secrets, npm_execpath: cli, TEST_RETAINED: 'yes', CI: 'fixture-ci' }, log: line => logs.push(line) });
  for (const args of [['run', 'anything'], [...UPLOAD, '--force'], ['exec', 'wrangler', 'delete'], ['run', 'check; echo unsafe']]) {
    await assert.rejects(run(args), code('unsupported_deployment_command'));
  }
  assert.deepEqual(logs, []);
  for (const command of [CHECK, BUILD]) await run(command);
  assert.equal(logs.length, 2);
  for (let i = 0; i < logs.length; i++) {
    const output = JSON.parse(logs[i]);
    assert.deepEqual(output.args, [CHECK, BUILD][i]);
    assert.equal(output.CI, 'fixture-ci');
    assert.equal(output.retained, 'yes');
    assert.deepEqual(output.credentials, Object.fromEntries(CREDENTIAL_KEYS.map(key => [key, null])));
  }
});

test('packageRunner permits authenticated migrate/upload but redacts all inherited management credentials', async t => {
  const f = await fixture(t);
  const cli = await fakePackageManager(f);
  const logs = [];
  const secrets = Object.fromEntries(CREDENTIAL_KEYS.map((key, i) => [key, `fixture-secret-${i}`]));
  const run = packageRunner({ root: f.root, environment: { ...secrets, npm_execpath: cli }, log: line => logs.push(line) });
  for (const command of [MIGRATE, UPLOAD]) await run(command, { authenticated: true });
  assert.equal(logs.length, 2);
  for (const line of logs) {
    for (const secret of Object.values(secrets)) assert.ok(!line.includes(secret), 'Management credential leaked into command output');
    const output = JSON.parse(line);
    assert.equal(Object.hasOwn(output, 'CI'), false, 'Runner must not change pnpm installation mode by injecting CI');
    assert.deepEqual(output.credentials, Object.fromEntries(CREDENTIAL_KEYS.map(key => [key, '[REDACTED]'])));
  }
});

test('packageRunner rejects npm/corepack execution shims instead of losing Wrangler remote flags', async t => {
  const f = await fixture(t);
  for (const name of ['npm-cli.js', 'npx-cli.js', 'corepack.js', 'unrelated.mjs']) {
    const cli = join(f.root, name);
    const logs = [];
    await assert.rejects(async () => {
      const run = packageRunner({ root: f.root, environment: { npm_execpath: cli }, log: line => logs.push(line) });
      await run(MIGRATE, { authenticated: true });
    }, code('pnpm_required'));
    assert.deepEqual(logs, []);
  }
});
