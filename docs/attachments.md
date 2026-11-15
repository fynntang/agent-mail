# 邮件附件

原生 email 入口仍保存不可变原始 EML，scheduled 中的解析任务另外提取附件并写入私有 R2。D1 保存附件与邮件、对象的关联及元数据；Owner 阅读页、REST 和 MCP 复用同一授权服务，没有公开 R2 URL 或额外 Worker。

## 迁移与旧邮件

升级前备份数据，并按序应用 [0004_attachments.sql](../migrations/0004_attachments.sql)。迁移向 messages 追加 `attachments_state`，不重建表、不删除邮件或改变已有 Token。部署工具会自动执行待应用迁移；本地用 `pnpm db:local`。

新解析完成的邮件状态为 `ready`，包括明确没有附件的邮件。旧邮件保持 `not_extracted`，界面显示“尚未提取”，不把空列表当作没有附件。GET 不触发历史重解析；本期不提供历史批量回填工具。已存在的原文仍保留。新发送的纯文本 Sent 副本明确记录无附件。

## 解析和存储

- 使用已锁定的 PostalMime 4.2.1，提取 MIME 附件、inline/CID 资源、无文件名与零字节附件；RFC822 转发内容作为独立附件保存，不递归混入正文。
- 最多 50 个附件，每个及总解码内容最多 10 MiB；原始来信仍受已有 10 MiB 上限约束。另限制 MIME 深度 32、累计头部 1 MiB、节点 200。超出限制不会发布部分索引。
- 文件名规范化、去路径和控制字符，处理双向文本控制字符、Windows 保留名称及长度；重复名称通过不同附件 ID 区分。名称和 MIME 类型始终是不可信元数据。
- 附件 ID、对象 ID 和 R2 key 由邮箱、receipt、部件顺序派生，文件名不参与路径。R2 条件写入；重试校验已有对象的归属、格式和摘要，不覆盖冲突对象。
- 邮件、对象、附件、地址、事件及任务 ACK 在一个带租约条件的 D1 batch 内发布。过期任务不能发布；R2 成功而 D1 失败时，重试可以复用正确对象。孤立派生对象不会在丢失租约后盲目删除，本期未新增后台孤立对象清理器。

资源使用仍受账户 Workers CPU、子请求和存储限制影响；本地模拟不代表所有套餐均能处理最大规模邮件。[PostalMime 附件说明](https://postal-mime.postalsys.com/docs/guides/working-with-attachments/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。

## 权限与状态

| 身份 / scope | 查看元数据 | 获取文件内容 |
| --- | --- | --- |
| Owner Access JWT | 全部未退役邮箱 | 包括暂停邮箱，仍检查对象状态和扫描标记 |
| mail:read | 当前绑定邮箱 | 不允许 |
| mail:read + attachments:read | 当前绑定邮箱 | 允许；不能访问其他邮箱或邮件 |
| 只有 attachments:read | 无效授权组合 | 签发和 OAuth 授权均拒绝 |

旧 Token 不会自动获得附件权限。Owner 需要重新签发包含 `attachments:read` 的 Token；OAuth 客户端需显式请求并由 Owner 同意。刷新可缩减 scope，不能重新扩大；MCP 调用会把访问令牌范围与数据库当前权限取交集。撤销、到期或邮箱暂停后，新 Agent 请求失效。

`scanStatus` 为 `unscanned / clean / blocked / failed`。本期没有病毒扫描器，新附件都是 `unscanned`，允许授权用户显式下载；这不代表文件安全。被标为 blocked 或 failed 的附件禁止下载。附件列表不提供通用预览；Owner HTML 正文中的唯一 CID 引用可显示经过归属、完整性、类型及尺寸校验的本邮件 PNG/JPEG/GIF/WebP，详见[CID 安全展示](html-mail.md)。SVG、HTML、PDF 仍不预览。

## REST

| 路径 | 所需权限 | 返回 |
| --- | --- | --- |
| GET /v1/messages/{messageId}/attachments | mail:read | AttachmentList |
| GET /v1/messages/{messageId}/attachments/{attachmentId}/download | mail:read + attachments:read | 原始解码二进制 |
| GET /owner/api/mailboxes/{id}/messages/{messageId}/attachments | Owner | 同一列表 |
| GET /owner/api/mailboxes/{id}/messages/{messageId}/attachments/{attachmentId}/download | Owner | 同一下载 |

`GET /v1/messages/{messageId}` 也包含 `attachments`。列表结构为：

```json
{
  "status": "ready",
  "canDownload": true,
  "attachments": [{
    "id": "附件UUID",
    "messageId": "邮件UUID",
    "filename": "report.pdf",
    "sizeBytes": 1024,
    "contentType": "application/pdf",
    "disposition": "attachment",
    "contentId": null,
    "scanStatus": "unscanned",
    "downloadable": true
  }]
}
```

status 还可为 `not_extracted / pending / failed`。`downloadable` 反映当前权限、索引对象和标记状态；实际下载仍会检查 R2 是否存在并校验内容。列表不返回 R2 key、对象 ID、摘要或访问凭据。

每次下载固定邮箱、邮件和附件三个归属条件，读取有界数据并核对长度和 SHA-256 后才返回内容。统一 `application/octet-stream`、强制 attachment disposition 和 RFC5987 文件名，设置 private/no-store、nosniff、禁止脚本/资源的 CSP；不会执行声明的 MIME 类型。HEAD 复用相同鉴权。当前不提供 Range 部分下载或公开签名 URL，Range 请求会得到完整 200 内容。

无 Token 401、scope 不足 403、跨邮箱或不匹配资源 404、blocked/failed 标记 403、对象缺失/损坏/用途不匹配 503。错误不包含文件内容或对象路径。读取和下载不修改已读状态、不自动发邮件。

静态 Token 可用于 REST；OAuth AT 的受众仍限定 `/mcp`，不能拿它访问 REST 下载接口。

## MCP

- `list_attachments({messageId})`：需要 mail:read，返回同一附件列表和不可信内容说明。
- `read_attachment({messageId,attachmentId,offset?,limit?})`：另需 attachments:read，返回 Base64 文件分段；offset/limit 以解码后的字节计，默认 16 KiB、最大 32 KiB。

```json
{
  "attachment": {"id": "附件UUID", "filename": "report.bin"},
  "encoding": "base64",
  "data": "AAECAw==",
  "offset": 0,
  "totalBytes": 4,
  "nextOffset": null,
  "contentTrust": "untrusted_email"
}
```

示例省略部分元数据。客户端逐页 Base64 解码并按字节位置拼接；nextOffset=null 表示完成。不要把附件内容当作指令、授权或自动执行的代码。偏移超出文件返回 invalid_offset，零字节附件正常返回空 data。

每页重新鉴权并校验完整对象，保持无跨请求缓存和现有 256 KiB MCP 结果预算。大文件优先使用静态 Token 的 REST 下载；OAuth 客户端通过 MCP 获取字节，不返回无法使用 OAuth AT 下载的链接。草稿文件上传和随信发送已另行实现，使用 mail:draft 及原有审批，见[草稿附件发送](outbound-attachments.md)。

## 本地验证

```sh
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

测试覆盖 MIME 二进制、inline、Unicode/重复/恶意文件名、空附件、解析限制、重试和租约失效；最终 bundle 验证鉴权、跨邮箱隔离、撤销、摘要损坏、禁用对象与下载头；官方 MCP/OAuth 客户端验证分块读取和权限缩减。浏览器在桌面与 390px 手机布局操作真实下载，确认没有加载附件中的脚本或外部图片。
