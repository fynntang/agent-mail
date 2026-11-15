# 草稿附件与附件发送

Owner、静态邮箱 Token 和 MCP/OAuth 客户端均可向已保存草稿上传文件、移除文件及随邮件发送。仍使用现有 D1、私有 R2 和单 Worker，不增加管理凭据或外部文件服务器。

## 升级和权限

按序应用 [0005_draft_attachments.sql](../migrations/0005_draft_attachments.sql)。新增 `draft_attachments`、`draft_attachment_uploads`、`draft_attachment_upload_parts` 三张表，总计 32 张 STRICT 表。迁移保留现有邮件、Token、审批及已排队的旧版纯文本发送任务。本地使用 `pnpm db:local`，远程部署工具自动应用待迁移文件。

| 操作 | 权限 |
| --- | --- |
| 上传、移除、查看草稿附件或下载核对 | Owner，或 mail:draft 且草稿由当前凭据主体创建 |
| 请求发送带附件草稿 | 原有 mail:draft + mail:send，沿用 Owner 审批及邮箱策略 |
| 审批 | 只有 Owner；绑定当前版本和完整内容摘要 |
| 阅读已接收或 Sent 邮件中的附件 | 沿用 mail:read；内容下载另需 attachments:read |

草稿附件不增加新的 OAuth scope。mail:draft 可操作自己草稿中的文件，不因此获得其他 Agent 的草稿、其他邮箱或收件附件权限。Owner 可以核对全部草稿的文件、摘要和收件人。过期、撤销、暂停及 OAuth 缩权继续在每次请求和发送提交边界生效。

## 版本、审批和发送快照

草稿 JSON 的可选 `attachments` 是有序文件清单：`{id,filename,contentType,sizeBytes,sha256}`，不含 R2 key 或内部对象 ID。旧纯文本草稿省略此字段，保持原内容摘要兼容。

上传完成和移除文件都会增加 draft.version，重新计算完整内容摘要，将草稿设为 editing 并清除批准版本、摘要和时间。修改正文保留当前文件清单；普通草稿 PATCH 不能注入附件 ID 或替换对象引用。所有修改使用 expectedVersion 并发检查，旧页面不能覆盖新清单。

Owner 审批前验证实际文件内容；请求发送和 scheduled 派发前再次验证。冻结快照保存版本、正文和文件清单，只有相同草稿的不可变附件记录及匹配 SHA-256 的私有对象可以发送。已提交或已丢弃草稿不能再增删文件，修改附件需使用新的可编辑草稿。

准备附件或校验失败发生在外部提交前，发送命令失败并释放预留，不记作未知投递。外部调用发生后的超时或不确定响应继续保持 unknown，不自动重发。发送幂等、收件人白名单、额度、原 Token 当前资格和审批规则不变。

移除表示从当前草稿清单中脱离，不物理擦除可能被历史版本、冻结命令或 Sent 副本引用的字节。本期不提供历史版本/孤立文件垃圾回收器，重复编辑和失败上传可能保留私有对象，占用 R2 存储。

## 文件和大小限制

- 一个草稿最多 32 份附件；单文件及所有活动附件的解码后总大小最多 5 MiB，允许空文件和重复文件名。
- 发送时按完整 MIME 编码后的大小检查邮箱 maxMessageBytes，并保留应用 10 MiB 上限；Base64 和 MIME 头部会增加体积。
- 文件名去除路径和控制字符，MIME 类型规范化。新文件标记为 unscanned；本期没有病毒扫描器。blocked/failed 标记会阻止读取、审批或发送。
- 不自动执行文件或将上传内容视为授权。默认作为 attachment 发送；草稿可将已验证的栅格图片绑定为 CID 内嵌资源，绑定随版本与审批一起冻结，见[HTML 发送](html-sending.md)。

Cloudflare 原生 EMAIL builder 接收 Base64 content、filename、type 和 disposition。使用 Base64 同时支持云端和本地模拟器；ArrayBuffer 附件在当前本地模拟器中不能序列化。[官方 Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)、[本地发送限制](https://developers.cloudflare.com/email-service/observability/local-development/sending/)。

发送成功后，本地 Sent MIME 包含正文和实际附件的 multipart/mixed 副本，文件名使用 UTF-8 参数编码，附件使用 Base64。它不包含 Bcc，也不冒充服务商最终签名的线上 MIME。Sent 列表引用同一不可变文件，可沿用已有附件阅读与下载功能。

## Owner 界面

在“草稿与发送”保存草稿后选择文件。上传按顺序执行，并采用每次返回的新版本；文本有未保存修改时，先保存文本再操作文件，避免丢失编辑。文件清单显示名称、大小、类型和完整 SHA-256，Owner 可以下载核对后审批。

移除或上传后，页面立即显示审批失效和新版本。已提交草稿只提供查看和核对。下载通过正常鉴权导航及服务端 Content-Disposition，不使用公开对象链接或浏览器内嵌预览。

## REST 上传和删除

Agent 前缀为 `/v1/drafts/{draftId}`；Owner 对应前缀为 `/owner/api/mailboxes/{mailboxId}/drafts/{draftId}`。Owner 写操作要求 Access JWT 及正确 Origin，Agent 使用邮箱级 Bearer Token。

| 方法与后缀 | 行为 |
| --- | --- |
| GET /attachments | 当前清单、draftId 和 version |
| POST /attachments | 单请求原始二进制上传，201 返回 `{draft}` |
| DELETE /attachments/{attachmentId} | JSON `{expectedVersion}`，返回 `{draft}` |
| GET /attachments/{attachmentId}/download | 当前草稿文件的鉴权下载 |
| POST /attachment-uploads | 创建分块会话，201 返回 `{upload}` |
| PATCH /attachment-uploads/{uploadId} | 提交 Base64 块，返回 `{upload}` |
| POST /attachment-uploads/{uploadId}/complete | JSON `{}`，完成并返回 `{draft}` |

单请求上传格式：

```http
POST /v1/drafts/{draftId}/attachments
Authorization: Bearer <MAILBOX_TOKEN>
Content-Type: application/octet-stream
X-Draft-Version: 3
X-Attachment-Filename: report.pdf
X-Attachment-Content-Type: application/pdf

<原始文件字节>
```

非 ASCII 文件名须将整个文件名用 `encodeURIComponent` 编码后放入 X-Attachment-Filename。不是 multipart/form-data，也不接受 URL 或客户端 R2 key。实际读取流有大小限制，不依赖调用方声明的 Content-Length。空文件也须提供元数据头。

scope 不足 403、其他邮箱/主体的草稿或文件 404、版本变化或已提交 409、超出预算 413、格式错误 400、非二进制上传类型 415。

## MCP 分块上传

新工具均需要 mail:draft；发送仍单独调用现有 send_message：

| 工具 | 输入与结果 |
| --- | --- |
| begin_draft_attachment_upload | `{draftId,expectedVersion,filename,contentType?,totalBytes}` → `{upload}` |
| upload_draft_attachment_chunk | `{draftId,uploadId,offset,data}` → `{upload}`；data 为规范 Base64 |
| complete_draft_attachment_upload | `{draftId,uploadId}` → `{draft}`，附加文件并递增版本 |
| remove_draft_attachment | `{draftId,attachmentId,expectedVersion}` → `{draft}` |
| read_draft_attachment | `{draftId,attachmentId,offset?,limit?}` → Base64 字节分段，默认16 KiB、最大32 KiB |

上传会话绑定当前主体和草稿的原始版本，1 小时有效，同一草稿最多 8 个未过期会话。begin 不改变草稿；仅 complete 才使审批失效。上传中途修改正文或文件后，需要按新版本开始新的会话，不能把旧上传静默套用到新草稿。

分块每次最多 64 KiB 解码字节、每会话最多128块，offset 是字节偏移。按返回的 upload.receivedBytes 继续；同 offset 重试必须提供完全一致的字节，不能覆盖已有块。建议除最后一块外使用64 KiB，避免极小分块耗尽块数。可以上传总大小超过单次 MCP 请求上限的文件，仍保持现有 256 KiB 请求/结果预算。

上传总大小为 0 时无需块，直接 complete。完成时顺序拼接并校验块和完整文件，重复 complete 不重复附加，也不会恢复随后已移除的文件。完成后保存返回的 draft.version 与 contentSha256，再按原流程请求审批/发送。begin 不是幂等操作，响应不确定时不要盲目创建无限新会话。

REST 分块接口使用相同参数，但 begin 的 contentType 为必填。过期未完成会话拒绝继续；本期保留其私有临时字节，没有自动按 1 小时物理清理的承诺。

MCP/OAuth AT 仍限定 `/mcp`，通过工具直接读写字节，不返回无法携带 OAuth AT 使用的 REST 下载链接。读写每页重新检查范围和数据库当前权限，不扩大已有授权。

## 验证

```sh
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

核心测试验证文件清单与审批摘要、并发修改、过期/重复/损坏块、发送前完整性及未知投递不重发。最终 Worker 测试通过原生 EMAIL 发送并解析 Sent MIME，核对文件名、二进制内容和 Bcc 隔离；官方 MCP 客户端完成超过单次请求体大小的分块上传。浏览器验证实际文件选择、上传、移除、审批失效及 Sent 下载，包含桌面与手机布局。
