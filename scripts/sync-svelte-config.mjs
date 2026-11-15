// 从唯一的部署配置生成 adapter 专用配置；只处理本地文件，不调用 Wrangler。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HTTP_ENTRY = '.svelte-kit/cloudflare/_worker.js';
export const RUNTIME_ENTRY = 'worker/entry.ts';
export const REQUIRED_COMPATIBILITY_FLAGS = ['nodejs_compat','global_fetch_strictly_public'];

/** Preserve deployer flags while refusing the switch that bypasses public routing for own-zone fetches. */
export function requiredCompatibilityFlags(flags = []) {
  assert.ok(Array.isArray(flags) && flags.every(flag => typeof flag === 'string' && flag.length > 0), 'compatibility_flags 必须是字符串列表');
  assert.ok(!flags.includes('global_fetch_private_origin'), '远程图片请求必须使用公共 Internet 路由，不能启用 global_fetch_private_origin');
  return [...new Set([...flags,...REQUIRED_COMPATIBILITY_FLAGS])];
}

export function parseJsonc(source) {
  let text = '', quoted = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (quoted) {
      text += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; text += c; }
    else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      text += '\n';
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      assert.ok(end !== -1, '未结束的 JSONC 注释');
      text += ' '; i = end + 1;
    } else text += c;
  }
  let clean = ''; quoted = false; escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; clean += c; }
    else if (c === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) continue;
    else clean += c;
  }
  return JSON.parse(clean);
}

export function createAdapterConfig(runtime) {
  const normal = x => x?.replaceAll('\\', '/').replace(/^\.\//, '');
  assert.equal(normal(runtime.main), RUNTIME_ENTRY, '部署 main 必须指向受版本控制的 worker/entry.ts');
  assert.equal(normal(runtime.assets?.directory), '.svelte-kit/cloudflare', 'assets 必须在生成目录中');
  assert.equal(runtime.assets?.binding, 'ASSETS');
  assert.equal(runtime.assets?.run_worker_first, true, '受保护页面/接口必须先经过 Worker');
  requiredCompatibilityFlags(runtime.compatibility_flags);
  for (const flag of REQUIRED_COMPATIBILITY_FLAGS) {
    assert.ok(runtime.compatibility_flags?.includes(flag), `部署配置必须启用 ${flag}，不能只在 adapter 中启用`);
  }
  const generated = structuredClone(runtime);
  generated.main = HTTP_ENTRY;
  // adapter 配置不能成为第二个独立部署目标。
  for (const key of ['route','routes','triggers','addresses','workers_dev','preview_urls','build']) delete generated[key];
  if (generated.queues) {
    if (generated.queues.producers?.length) generated.queues = { producers: generated.queues.producers };
    else delete generated.queues;
  }
  return generated;
}

export async function syncConfig(runtimePath, adapterPath, check = false) {
  const input = resolve(runtimePath), output = resolve(adapterPath);
  assert.notEqual(input, output, '不能覆盖部署配置');
  assert.equal(basename(output), 'wrangler.svelte.jsonc', '输出必须是专用生成配置文件');
  assert.equal(dirname(input), dirname(output), '两配置必须同目录，避免相对资源路径漂移');
  const generated = createAdapterConfig(parseJsonc(await readFile(input, 'utf8')));
  if (check) {
    assert.deepEqual(parseJsonc(await readFile(output, 'utf8')), generated, 'adapter 配置已漂移，请重新生成');
  } else {
    await writeFile(output, '// GENERATED: adapter 构建输入，不得单独部署。\n' + JSON.stringify(generated, null, 2) + '\n');
  }
  return generated;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const paths = args.filter(x => x !== '--check');
  await syncConfig(paths[0] ?? 'wrangler.jsonc', paths[1] ?? 'wrangler.svelte.jsonc', args.includes('--check'));
  console.log(args.includes('--check') ? 'SvelteKit 配置一致' : '已生成 adapter 配置；未构建或部署 Worker');
}
