# HTML 与 CID 邮件发送

Owner、REST 和 MCP 共用现有草稿、附件上传、邮箱权限、审批及发送队列。仍是一个 Worker，使用现有 D1 表和私有 R2；不新增迁移、绑定或发送服务。

## 正文与草稿契约

草稿增加两个可选字段：

```json
{
  "to": ["recipient@example.net"],
  "subject": "构建报告",
  "text": "构建成功。配图见 HTML 版本。",
  "html": "<h2>构建成功</h2><img src=\"cid:Logo%40Agent\" alt=\"构建配图\">",
  "inlineImages": [{"attachmentId": "当前草稿已上传的附件 UUID", "contentId": "Logo@Agent"}]
}
```

创建草稿可先省略 inlineImages，保存 HTML 后再上传文件，并使用新版本号绑定附件。公共 JSON 仍不能直接写 attachments 清单或 R2 对象地址。REST 创建/修改路径为 POST /v1/drafts、PATCH /v1/drafts/{id}；Owner 在 /owner/api/mailboxes/{id}/drafts 下使用相同内容字段。修改必须提供 expectedVersion。

- text 与 html 各自最多 64 KiB UTF-8。允许保存未完成草稿；发送始终要求非空文本备用正文、主题和至少一个收件人，不自动生成备用文本。
- html 是实际发送的原始源码，保留样式与字符内容，只检查类型、字节、控制字符和解析复杂度。空白 HTML 规范化为 null。安全预览另行清洗，不能将预览当成收件客户端的完整视觉还原。
- 修改时省略 html/inlineImages 会保留已有值；html:null 清除 HTML 和已有绑定，inlineImages:[] 将所有文件恢复为普通附件。清除 HTML 时同时提供非空绑定会被拒绝。
- 原有收件人、主题、text、replyMessageId 仍遵守完整替换规则；省略文本/收件人会清空，省略回复关联会解除回复。附件清单由服务端保留。
- 请求 JSON 和不可变草稿/快照对象最多 256 KiB，转义后的 JSON 也受限。MCP 保留原有 256 KiB 请求/结果预算。

MCP 仍为 18 个工具。create_draft、update_draft、reply_message 支持以上字段；上传继续使用 begin_draft_attachment_upload → upload_draft_attachment_chunk → complete_draft_attachment_upload。HTML/CID 不增加 Agent scope，发送仍要求 mail:draft + mail:send，回复另需 mail:read。get_draft 可以返回本主体草稿的原始 HTML，按不可信数据处理；read_message 继续只返回文本。

## CID 绑定与附件

inlineImages 最多 8 条，每条只含 attachmentId 和 contentId。附件 ID 必须存在于本草稿当前有效清单；跨草稿、跨邮箱、已移除及伪造的引用均拒绝。Content-ID 为保留大小写的规范化 ID，不带外层尖括号，发送 ID 最多 984 个 ASCII 字符，为 MIME 头前缀和尖括号预留行长；禁止控制字符、空白、重复附件 ID 和重复 Content-ID。HTML 中的 cid: URL 只解码一次，按相同规则匹配。

编辑期间允许 HTML 暂时引用未绑定的 CID。审批、提交和派发前，所有 img 的 CID 引用必须有效且已绑定。绑定资源仅允许校验过的 PNG/JPEG/GIF/WebP：每张最多 1 MiB，绑定图片总计最多 4 MiB，限制画布尺寸，复用 MIME/魔数校验。普通附件仍可使用其他类型，受原来的最多 32 个文件、总计 5 MiB 限额约束。没有新增病毒扫描器，unscanned 仍不表示已扫描。

现有上传支持原始二进制及分块；上传完成会增加版本、改变内容摘要并撤销审批。修改 CID 绑定同样如此。移除附件自动解除相应绑定，但不会自动改写 HTML 源码；需要修复残留 CID 引用后重新审批。回复不会自动复制收到的 CID 图片，需要显式上传到新草稿。

## Owner 编辑与安全预览

草稿页面可填写文本备用正文，开启“添加 HTML 正文”编辑源码。上传图片后，可设置 Content-ID 并将对应 img 标签插入源码。保存后显示完整原始源码和安全预览；HTML 草稿的审批按钮还要求勾选已核对当前版本。此交互提示不替代服务端 Owner 鉴权和版本/hash 校验。

预览端点：

```text
GET /owner/api/mailboxes/{id}/drafts/{draftId}/html
    ?expectedVersion={version}&contentSha256={hash}
```

必须精确提供这两个参数。端点仅允许通过 Access 验证的 Owner，在读取附件前后核对当前草稿的版本和内容摘要。过期预览返回 draft_changed，不展示并发编辑后的其他版本；Token 和 OAuth AT 不能调用。预览无写入、不请求远程图片、不生成公开附件地址。

预览复用语义 HTML 清洗和空 sandbox iframe，禁止脚本、同源、表单、导航、连接及外部图片。CID 从本草稿附件校验后以 data URI 显示；不可用资源保持占位。HTTP 响应包含 sandbox CSP、frame-ancestors self、SAMEORIGIN、no-referrer、nosniff 和 private/no-store。没有通过主 DOM 的 {@html} 注入。

本地修改尚未保存时隐藏旧预览，禁止审批/发送；每次保存或文件变更后需重新核对。原始 HTML 在编辑器和审批源码区均按文本转义显示，实际发送采用该版本保存的源码。

## 审批、快照与 Sent

HTML、文本、绑定及有序附件清单全部进入同一个内容摘要，任何修改都使已有审批失效。派发前重新验证原始 Token 权限、撤销状态、邮箱策略、审批版本及 R2 文件大小/SHA-256/扫描状态。预检失败发生在 submitting 边界之前，不调用发送服务；已有幂等、额度、超时及 unknown 不重发规则保持不变。

带 HTML/CID 字段的新发送采用 v3 冻结快照；旧 v1/v2 快照与原摘要继续可用。原生 EMAIL.send 接收 text、html，以及 disposition:inline/contentId 的图片；普通文件继续 disposition:attachment。实际提供商 MIME、签名和 Message-ID 由 Cloudflare 生成。[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)、[内嵌图片示例](https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/)。

应用的本地 Sent EML 使用 multipart/alternative 保存两种正文，HTML 与 CID 图片组成 multipart/related，有普通附件时再包 multipart/mixed。内容使用 Base64 编码，Unicode 文件名使用 RFC2231，Bcc 不写入公开头。此文件仍是本地副本，不冒充提供商最终线上 MIME。

Sent 的私有正文保存实际 HTML，附件 disposition/content_id 从冻结绑定创建，不读取后续草稿内容。Owner 阅读页复用既有清洗/CID 展示；普通邮件 API/MCP 不返回原始 HTML，也不因此扩大附件读取权限。

## 本地验证

运行 pnpm check、pnpm build:worker、pnpm test、pnpm test:e2e。覆盖 MIME 解析往返、原生 builder 双正文与 CID 字段、审批失效、跨草稿引用、坏图片及冻结后损坏、旧快照、JSON 上限和预备对象清理；REST、官方 MCP/OAuth 客户端和 Owner 浏览器验证完整发送及 Sent 阅读。

浏览器使用既有 Playwright/Chrome（当前无 Browser 插件），检查桌面与手机的编辑、预览、上传、审批、发送、Sent HTML/CID 与下载。没有远程部署或真实外部邮件投递验收。
