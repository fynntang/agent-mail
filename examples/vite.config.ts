// 未来项目根 vite.config.ts 的设计示例；当前未安装 SvelteKit。
// 基线：SvelteKit 3.2.0 + adapter-cloudflare 8.0.2，正式发布需 lockfile。
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit({
    adapter: adapter({ config: 'wrangler.svelte.jsonc' })
  })]
});
