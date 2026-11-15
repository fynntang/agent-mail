# Agent Mail 个人自部署设计

一个实例属于一个部署者，管理多个 Agent 邮箱；每个 Token 严格绑定一个邮箱。当前方案已替换原有 Rust、PostgreSQL 与 Stalwart 多租户设计。

- [架构与数据流程](architecture.md)
- [本地开发与验证](development.md)
- [Owner 控制台与 Access 配置](owner-console.md)
- [邮件阅读与分页](mail-reader.md)
- [邮件发送、回复与审批](mail-sending.md)
- [HTML/CID 邮件发送](html-sending.md)
- [事件、Webhook 配置与签名验证](webhooks.md)
- [告警通知决策与降噪统计](alert-notification-decisions.md)
- [CSV/JSON 同步导出](alert-notification-export.md)与[大批量异步导出](async-alert-notification-export.md)
- [导出完成与失败通知](async-export-notifications.md)
- [导出通知投递追踪与安全重试](async-export-notification-deliveries.md)
- [失败导出通知的批量重试](async-export-notification-retry-batches.md)
- [SvelteKit项目结构与四类入口](project-structure.md)
- [数据库逐表字典](database.md)
- [D1 参考快照](schema.sql)与[初始迁移](../migrations/0001_initial.sql)
- [API 与 MCP](api-mcp.md)
- [MCP 接入、工具及权限](mcp.md)
- [OAuth 客户端授权与迁移](oauth.md)
- [开源与部署流程](deployment.md)
- [验证与尚未实现的能力](validation.md)
- [SvelteKit单Worker配置验证](svelte-validation.md)

基础服务、Owner 控制台、HTML/CID 与附件收发、MCP/OAuth、部署向导、Webhook、投递事件、抑制管理和异步导出通知已通过本地验证，复用邮箱权限、Owner 同意、审批、幂等和防重发。真实域名和服务商投递仍需云端验收；公开部署按钮发布及 STDIO 桥接另行完成。

框架为 SvelteKit，最终只部署一个含 fetch/email/scheduled/queue 的 Worker。按顺序应用至0017迁移，保留原始表，共53张 STRICT 表。
