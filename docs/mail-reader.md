# 邮件阅读与分页

入口为 `/owner/mailboxes/{mailboxId}/messages`。控制台侧栏和邮箱名称默认进入阅读界面；“邮箱设置”保留原有邮箱与 Token 管理。首次创建邮箱仍先进入设置页，方便签发凭证。

本轮沿用已有 `messages / message_addresses / objects / audit_events`、私有 R2 和认证服务，不增加数据库迁移或 Worker。原始 MIME 和派生正文仍由原生收信/定时解析入口保存。

## 界面行为

- 按邮箱查看邮件摘要、发件人、接收时间及未读标记；支持文件夹和全部/已读/未读筛选。
- 默认收件箱每页 20 封，可选 10/20/50/100 封；提供前后翻页。更改筛选或每页数量会回到第一页。
- 选择邮件显示提取的文本正文、收发地址和 UTC 接收时间。URL 保存选中邮件、筛选和游标，可刷新、前进/后退或直接打开。
- 打开正文、页面预加载和 GET 不会修改已读状态。Owner 显式点击“标记为已读/未读”才会写入；提交期间按钮禁用，使用目标状态而非 toggle，重试不会反转结果。
- 标记后邮件可能离开当前筛选结果，阅读区保留已打开的正文并提示。若整页已不再有匹配记录，可通过“返回第一页”重新查询当前筛选，不必重新选择邮箱。
- 手机上列表与正文上下排列，点击邮件后定位至正文；切换邮箱会销毁旧组件并中止旧的客户端请求。中止请求不代表服务器回滚，重新进入时读取数据库实际状态。

暂停邮箱仍允许 Owner 阅读和管理历史邮件；邮箱 Token 会被拒绝。已退役邮箱与 `deleted_at` 非空的邮件不可通过阅读接口访问。

## 邮件接口

| 方法与路径 | 主体 | 当前行为 |
| --- | --- | --- |
| GET /owner/api/mailboxes/{id}/messages | Owner | 分页列表 |
| GET /owner/api/mailboxes/{id}/messages/{messageId} | Owner | 元数据、地址及文本正文 |
| PATCH /owner/api/mailboxes/{id}/messages/{messageId} | Owner | JSON `{isRead:true}` 或 `{isRead:false}` |
| GET /v1/messages | 邮箱 Token + mail:read | Token 固定邮箱的分页列表 |
| GET /v1/messages/{messageId} | 邮箱 Token + mail:read | Token 固定邮箱的正文 |

Agent API 没有写阅读状态的接口，既有只读 Token 不会获得新写权限。Owner PATCH 继续要求 Access JWT 和严格匹配的 Origin，所有私有响应保持 no-store。状态更新和审计在同一 D1 batch 内以唯一操作 ID 守卫；重复写入相同状态不重复生成变更审计。邮件解析重试不会重建已有消息或重置已读状态。

列表参数：

| 参数 | 约定 |
| --- | --- |
| limit | 整数 1–100，默认 20 |
| folder | all / inbox / sent / archive / trash / spam；API 默认 all，控制台默认 inbox |
| read | all / read / unread，默认 all |
| cursor | 上一次响应的 nextCursor 或 previousCursor |

`GET /v1/messages` 从原先固定最近 50 条升级为分页，需保留旧页大小时显式传 `limit=50`。现有摘要字段保留，新增发件人、filters、nextCursor、previousCursor；没有可继续的方向时游标为 null。

```http
GET /v1/messages?folder=inbox&read=unread&limit=20
Authorization: Bearer <MAILBOX_TOKEN>
```

以 `(received_at DESC, id DESC)` 排序，使用接收时间而非发件人提供的 Date。游标包含版本、邮箱、筛选、页大小、方向和位置，严格校验后才绑定 SQL 参数；同时间以 ID 打破平局。边界邮件被改为已读或删除后，游标不依赖该行仍然存在。

游标是位置而非凭证，不承担授权功能；每次请求仍独立校验身份和邮箱范围。它不是一致性快照：新邮件、延迟解析和已读变化会改变结果集合。新增的较新邮件通常需要刷新才能出现在第一页，界面不显示不可靠的总页数。

## 正文与安全边界

服务先通过邮箱与消息 ID 查 D1，再解析该消息引用的同邮箱 `purpose=body / state=ready` 对象；客户端不能传入 R2 key 或 object ID 读取内容。读取时校验对象大小与 SHA-256，单个派生正文对象上限 16 MiB。跨邮箱或已删除消息统一返回 404，响应不包含 R2 key、对象摘要或 Token。

纯文本模式取 JSON 中的 `text`，通过 Svelte 默认转义显示并保留换行。Owner 可切换服务端清洗后的 HTML，使用空权限 iframe 沙箱和 CSP；本邮件的安全 CID 图片从私有附件校验后内嵌，不在控制台主 DOM 注入 HTML，也不自动加载远程图片。远程许可需逐封确认并通过受 Origin 保护的 POST 获取，切换纯文本或邮件即重置。完整策略、旧格式兼容和状态见[HTML 阅读](html-mail.md)。附件列表支持名称、大小、类型、inline 标记和显式下载，不提供通用附件预览，见[附件说明](attachments.md)。

正文返回明确状态：

| body.status | 含义 |
| --- | --- |
| ready | 可显示的提取文本 |
| empty | 提取的文本为空字符串 |
| not_extracted | text 为 null，尚无可显示文本；不凭此认定是 HTML-only |
| pending / failed | 索引记录的解析状态 |
| unavailable | 正文对象缺失、未就绪、格式/摘要不符或超过读取限制 |

元数据仍可读取时，接口以200返回这些明确状态，`body.text` 在不可显示时为 null。另有 body.htmlStatus 描述 HTML 可用性；原 HTML 不进入普通邮件 DTO，旧正文显示尚未提取，HTML-only 来信生成有界纯文本。界面不把读取失败伪装成空正文。阅读页已提供回复入口，双正文与 CID 发信见[草稿与发送](mail-sending.md)；通用附件预览及线程归并仍是后续能力。

## 本地验证

```sh
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

`tests/unit/mail.test.ts` 使用真实本地 D1/R2 覆盖同时间分页、前后往返、边界消失、新邮件、游标绑定、对象用途、摘要失败、正文状态及幂等审计。`tests/integration/mail.test.mjs` 直接运行最终 bundle，验证 Access/Token/Origin 和 HTTP 行为；原生解析重试用例还检查已读状态不会重置。

浏览器用例在 `http://127.0.0.1:4194` 使用隔离测试身份，覆盖两个邮箱、23 封普通邮件及恶意文本、分页、筛选、持久状态、错误提示和手机定位。桌面 1488×1056、手机 390×844 均已验证，无相关 console/page 错误或外部追踪图片请求。MAIL_QA_DIR 可指定仓库外截图目录，端口可通过 OWNER_E2E_PORT 调整。

本轮验证使用测试 RSA/JWKS 和内存数据，不改变生产信任规则、不读取 `.wrangler/state`、不发布远程资源或触发真实邮件发送。实际 Access 登录及云端资源仍需部署后单独验收。
