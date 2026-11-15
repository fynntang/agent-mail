// 无外部依赖的配置生成检查；不构建SvelteKit、不调用Cloudflare。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseJsonc, createAdapterConfig, syncConfig, HTTP_ENTRY, RUNTIME_ENTRY, REQUIRED_COMPATIBILITY_FLAGS } from './sync-svelte-config.mjs';

const checks = [];
const check = async (label, fn) => { await fn(); checks.push(label); };
const runtimeUrl = new URL('../examples/wrangler.personal.jsonc', import.meta.url);
const adapterUrl = new URL('../examples/wrangler.svelte.jsonc', import.meta.url);
const runtimeText = await readFile(runtimeUrl, 'utf8');
const runtime = parseJsonc(runtimeText);
const sample = parseJsonc(await readFile(adapterUrl, 'utf8'));
const generated = createAdapterConfig(runtime);

await check('JSONC注释不会破坏HTTPS或字符串内容', () => {
  assert.deepEqual(parseJsonc('{"url":"https://example.com/a,//b/*c*/",/*comment*/"text":"a\\\"b"//tail\n}'), {url:'https://example.com/a,//b/*c*/',text:'a"b'});
});
await check('JSONC尾随逗号可用且字符串逗号不丢失', () => {
  assert.deepEqual(parseJsonc('{"s":",}","a":[1,2,],}'), {s:',}',a:[1,2]});
});
await check('最终部署入口与adapter输出入口分开', () => {
  assert.equal(runtime.main, RUNTIME_ENTRY);
  assert.equal(generated.main, HTTP_ENTRY);
  assert.notEqual(generated.main, runtime.main);
});
await check('生成配置不会修改部署源对象', () => assert.deepEqual(runtime, parseJsonc(runtimeText)));
await check('ASSETS绑定与Worker优先执行保留', () => {
  assert.equal(generated.assets.binding, 'ASSETS');
  assert.equal(generated.assets.run_worker_first, true);
  assert.equal(generated.assets.directory, '.svelte-kit/cloudflare');
});
await check('DB/R2/EMAIL绑定与实际ID从源配置派生', () => {
  const customized = structuredClone(runtime);
  customized.d1_databases[0].database_id = '12345678-1234-1234-1234-123456789abc';
  customized.r2_buckets[0].bucket_name = 'my-personal-mail';
  const output = createAdapterConfig(customized);
  assert.deepEqual(output.d1_databases, customized.d1_databases);
  assert.deepEqual(output.r2_buckets, customized.r2_buckets);
  assert.deepEqual(output.send_email, customized.send_email);
});
await check('日期与环境变量保持一致', () => {
  assert.equal(generated.compatibility_date, runtime.compatibility_date);
  assert.deepEqual(generated.vars, runtime.vars);
});
await check('原生部署、样例与adapter均保留公共fetch和Node兼容标记', async () => {
  const actual=parseJsonc(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  for(const config of [actual,runtime,generated])for(const flag of REQUIRED_COMPATIBILITY_FLAGS) assert.ok(config.compatibility_flags.includes(flag));
  assert.deepEqual(generated.compatibility_flags,runtime.compatibility_flags);
});
await check('缺少必要标记时拒绝仅生成安全adapter掩盖原生配置', () => {
  for(const flags of [undefined,[],['nodejs_compat'],['global_fetch_strictly_public']])assert.throws(()=>createAdapterConfig({...runtime,compatibility_flags:flags}));
});
await check('拒绝会绕过公共路由的private-origin反向标记', () => {
  assert.throws(()=>createAdapterConfig({...runtime,compatibility_flags:[...runtime.compatibility_flags,'global_fetch_private_origin']}));
});
await check('Cron和其他部署触发器不进入adapter配置', () => {
  const customized = {...runtime, routes:['a.example/*'], addresses:['a@example.com'], workers_dev:true, build:{command:'example'}};
  const output = createAdapterConfig(customized);
  for (const key of ['routes','addresses','workers_dev','triggers','build']) assert.ok(!(key in output));
  assert.ok(runtime.triggers.crons.length > 0);
});
await check('Queue生产绑定可用但consumer仅留在最终部署', () => {
  const customized = {...runtime, queues:{producers:[{binding:'EVENTS',queue:'events'}],consumers:[{queue:'events'}]}};
  assert.deepEqual(createAdapterConfig(customized).queues,{producers:customized.queues.producers});
  assert.equal(customized.queues.consumers.length,1);
});
await check('错误main不能成为adapter配置源', () => assert.throws(() => createAdapterConfig({...runtime,main:'src/index.ts'})));
await check('生成目录不能指向源码或外部路径', () => assert.throws(() => createAdapterConfig({...runtime,assets:{...runtime.assets,directory:'../src'}})));
await check('关闭Worker优先执行时拒绝生成', () => assert.throws(() => createAdapterConfig({...runtime,assets:{...runtime.assets,run_worker_first:false}})));
await check('拒绝覆盖部署配置文件', () => assert.rejects(syncConfig(fileURLToPath(runtimeUrl),fileURLToPath(runtimeUrl))));
await check('拒绝把生成结果写入其他文件名', () => assert.rejects(syncConfig(fileURLToPath(runtimeUrl),fileURLToPath(new URL('../examples/vite.config.ts',import.meta.url)))));
await check('两配置不能跨目录导致相对路径漂移', () => assert.rejects(syncConfig(fileURLToPath(runtimeUrl),fileURLToPath(new URL('../wrangler.svelte.jsonc',import.meta.url)))));
await check('已保存的adapter样例与生成结果一致', async () => {
  assert.deepEqual(sample,generated);
  await syncConfig(fileURLToPath(runtimeUrl),fileURLToPath(adapterUrl),true);
});
await check('Vite样例显式选择adapter专用配置', async () => {
  const vite = await readFile(new URL('../examples/vite.config.ts',import.meta.url),'utf8');
  assert.ok(vite.includes("config: 'wrangler.svelte.jsonc'"));
});
await check('验证过程未修改最终部署样例', async () => assert.equal(await readFile(runtimeUrl,'utf8'),runtimeText));

if (process.argv.includes('--report')) {
  await writeFile(new URL('../docs/svelte-validation.md',import.meta.url),
    '# SvelteKit单Worker配置验证\n\n'
    + '运行环境：Node.js '+process.version+'。通过'+checks.length+'项本地配置检查。\n\n'
    + '```sh\nnode scripts/validate-svelte-config.mjs\nnode scripts/sync-svelte-config.mjs examples/wrangler.personal.jsonc examples/wrangler.svelte.jsonc --check\n```\n\n'
    + '[生成器](../scripts/sync-svelte-config.mjs)与[检查脚本](../scripts/validate-svelte-config.mjs)均可运行，无外部依赖，不调用Cloudflare。\n\n'
    + '## 通过的检查\n\n'+checks.map((c,i)=>(i+1)+'. '+c).join('\n')+'\n\n'
    + '## 应用验证与边界\n\n已有应用源码、package/lockfile和单Worker骨架，应用构建、类型与原生事件由独立集成测试验证；见[本地开发与验证](development.md)。本脚本本身只检查配置，不执行构建或Cloudflare部署。\n\n'
    + '发布前必须验证：最终产物同时导出fetch/email/scheduled及可选queue，SvelteKit HTTP响应/静态资源、两origin鉴权、MCP流与取消、真实邮件接收、定时任务、D1/R2绑定及单次部署。详见[项目结构](project-structure.md)与[部署流程](deployment.md)。\n');
}
console.log(JSON.stringify({runtime:process.version,checksPassed:checks.length,checks},null,2));
