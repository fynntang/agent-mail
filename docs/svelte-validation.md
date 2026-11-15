# SvelteKit单Worker配置验证

运行环境：Node.js v24.22.1。通过21项本地配置检查。

```sh
node scripts/validate-svelte-config.mjs
node scripts/sync-svelte-config.mjs examples/wrangler.personal.jsonc examples/wrangler.svelte.jsonc --check
```

[生成器](../scripts/sync-svelte-config.mjs)与[检查脚本](../scripts/validate-svelte-config.mjs)均可运行，无外部依赖，不调用Cloudflare。

## 通过的检查

1. JSONC注释不会破坏HTTPS或字符串内容
2. JSONC尾随逗号可用且字符串逗号不丢失
3. 最终部署入口与adapter输出入口分开
4. 生成配置不会修改部署源对象
5. ASSETS绑定与Worker优先执行保留
6. DB/R2/EMAIL绑定与实际ID从源配置派生
7. 日期与环境变量保持一致
8. 原生部署、样例与adapter均保留公共fetch和Node兼容标记
9. 缺少必要标记时拒绝仅生成安全adapter掩盖原生配置
10. 拒绝会绕过公共路由的private-origin反向标记
11. Cron和其他部署触发器不进入adapter配置
12. Queue生产绑定可用但consumer仅留在最终部署
13. 错误main不能成为adapter配置源
14. 生成目录不能指向源码或外部路径
15. 关闭Worker优先执行时拒绝生成
16. 拒绝覆盖部署配置文件
17. 拒绝把生成结果写入其他文件名
18. 两配置不能跨目录导致相对路径漂移
19. 已保存的adapter样例与生成结果一致
20. Vite样例显式选择adapter专用配置
21. 验证过程未修改最终部署样例

## 应用验证与边界

已有应用源码、package/lockfile和单Worker骨架，应用构建、类型与原生事件由独立集成测试验证；见[本地开发与验证](development.md)。本脚本本身只检查配置，不执行构建或Cloudflare部署。

发布前必须验证：最终产物同时导出fetch/email/scheduled及可选queue，SvelteKit HTTP响应/静态资源、两origin鉴权、MCP流与取消、真实邮件接收、定时任务、D1/R2绑定及单次部署。详见[项目结构](project-structure.md)与[部署流程](deployment.md)。
