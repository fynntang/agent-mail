# HTML 邮件安全阅读

Owner 阅读页支持纯文本和 HTML 切换。默认仍显示纯文本；HTML 通过服务端清洗后放入独立沙箱，不进入控制台的主 DOM。原生 email、scheduled、SvelteKit 页面和接口继续由同一个 Worker 提供，使用现有 D1、私有 R2 和 Cloudflare Access。

## 正文存储与兼容

新解析的来信使用 `body/v3` 派生对象，保存 MIME 文本及私有 HTML，原始 EML 仍保持不可变。正文对象继续使用既有 objects 表，无新增表或数据库迁移；重试使用版本化 key、条件写入和原有 D1 租约批次，避免覆盖旧格式。

邮件有 MIME 纯文本时优先使用它；只有 HTML 时，通过清洗器和 HTML 解析器生成有界纯文本及列表摘要。普通 Owner JSON、Agent API 和 MCP 只返回文本和 HTML 可用状态，不返回原始 HTML。MCP 不增加 HTML 工具或浏览器渲染能力。

旧 `body/v1`、`body/v2` 保持 `not_extracted`；GET 不读取原始 EML 回填，也不改写数据库或已读状态。原文保留，本期未新增历史批量回填工具。新发送的纯文本 Sent 副本明确标记没有 HTML。

## 清洗策略

依赖锁定为 `sanitize-html 2.18.2` 和 `htmlparser2 12.0.0`，在 Worker 内执行，不依赖浏览器 DOM、jsdom 或外部清洗服务。[sanitize-html 文档](https://www.npmjs.com/package/sanitize-html)、[HTML 解析器](https://github.com/fb55/htmlparser2)。

当前策略版本为 `mail-html-v3`：

- 保留段落、标题、粗体、强调、代码、列表、引用及表格等基本语义结构。
- 移除发件人的全部 CSS，使用应用提供的固定排版；移除脚本、事件属性、表单、嵌套页面、对象、媒体、SVG/MathML、模板、base、外部样式及刷新跳转。
- 不保留 ID、name、自定义属性、srcdoc、srcset、内嵌导航 href 或 CSS URL。表格跨行/跨列等少数数值属性受限。
- 远程图片默认替换为转义的说明文字。CID 仅允许当前邮件的已校验附件映射；邮件直接提供的 data、blob、协议相对及不支持的 URL 不加载。不保留惰性加载或替代来源属性。
- 从邮件提取最多 50 个经过校验的外部 HTTPS 链接，在沙箱外显示完整地址。标签和地址由 Svelte 转义；用户自行核对并点击，使用 noopener/noreferrer。

HTML 输入最多 512 KiB UTF-8、最多 20,000 个元素和 64 层，清洗后正文最多 1 MiB。图片另有下面的预算；不能通过重复图片标签放大文档。超大或异常 HTML 不进入阅读沙箱；已提供的纯文本和附件索引保持可用。新来信超出 HTML 大小预算时，派生对象不再复制该大段 HTML，完整内容仍在原始 EML。

清洗在展示时执行，因此后续策略更新可作用于已有 v3 正文，不需要将旧的清洗结果永久视为可信。

## 沙箱隔离

iframe 使用空 `sandbox` 和 `referrerpolicy="no-referrer"`，不授予脚本、同源、表单、弹窗、顶层导航或下载权限。默认文档另带 HTTP CSP sandbox，图像许可后的 srcdoc 仍由相同空 iframe 沙箱限制。控制台不使用 `{@html}` 注入邮件。[iframe 沙箱](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)、[srcdoc 注意事项](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc)。

没有可显示图片时，正文 CSP 包括：

```text
default-src 'none'; script-src 'none'; style-src 'unsafe-inline';
img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none';
frame-src 'none'; object-src 'none'; font-src 'none'; media-src 'none'
```

`style-src 'unsafe-inline'` 只为可信文档包装中的固定 CSS 服务；发件人样式已全部清除。默认 HTML HTTP 响应还设置 `sandbox`、`frame-ancestors 'self'`、X-Frame-Options SAMEORIGIN、nosniff、no-referrer 和 private/no-store。其他 Owner 页面继续默认 DENY，附件下载等已有显式保护保持不变。

## CID 内嵌图片

切换到 HTML 正文后，当前邮件中能够安全解析的 CID 图片直接显示，不需要开启远程图片许可。Worker 从清洗器收集的 `cid:` 引用中匹配当前邮箱、当前邮件的附件索引，通过既有授权及对象读取链路验证 ready 状态、attachment 用途、大小、SHA-256 和扫描标记，之后以栅格 data URI 嵌入沙箱。不会把私有 R2 URL、对象 key 或下载凭据交给 iframe，也不会访问网络解析 CID。

CID URL 去除协议前缀后只进行一次百分号解码；Content-ID 头仅移除外层配对尖括号，不作 URL 解码。匹配保留大小写，兼容常见不带 `@` 的 MIME ID，拒绝空值、空白、控制字符、非法编码和超长值。[RFC 2392](https://www.rfc-editor.org/rfc/rfc2392)。新收信无效 Content-ID 保存为空，保留附件本身，不通过删除字符或截断修复标识；历史索引以已有值为准，不自动重解析。同一邮件有多个规范化后相同的 Content-ID 时保守拒绝该 ID，不猜测 MIME 分支；不会到其他邮件或邮箱寻找同名资源。`Content-Location`、`mid:` 及相对路径均不作为回退。附件 disposition 不影响 CID 匹配，但仍需唯一 ID、允许读取的状态和受支持的栅格类型。

仅接受 PNG、JPEG、GIF、WebP，并复用远程图片的魔数及画布尺寸校验。SVG、HTML、MIME/魔数不符、blocked/failed、缺失或损坏的附件显示占位提示，正文保持可读。`unscanned` 仍不是已通过病毒扫描的声明；校验不执行完整解码或转码。

CID 和远程图片共用每封文档最多 8 个图片节点、单图 1 MiB、总计 4 MiB 原始图片字节的预算，重复引用也计入文档预算。已显示的 CID 资源优先保留，开启远程图片时只使用剩余预算，不挤掉本地图像。所有文档继续禁止 HTTPS 图片和连接；存在已校验图片时，仅将 `img-src` 设为 `data:`。恢复屏蔽操作只撤销远程许可，CID 仍可显示。

普通邮件读取的 Owner JSON、Agent API 和 MCP 继续只输出文本，不新增 CID 下载接口或图片权限旁路。Token 读取附件仍单独要求 attachments:read；Owner HTML 端点始终要求 Access 身份。历史正文或附件尚未提取时不自动回填原始 EML。本次复用已有 content_id 索引字段及私有对象，无新增表、迁移、绑定或 Worker。

## 远程图片许可

默认模式不产生外部图片网络请求，CID 只读取本实例的私有 R2。Owner 点击“加载远程图片”并确认后，同一 Worker 从已验证正文提取地址、下载图片，再返回包含栅格 data URI 的清洗文档。浏览器只显示内嵌字节，不直接请求图片来源，因此远端不提供 Access-Control-Allow-Origin 也能显示。远程许可仅用于当前邮件的当前展示；切回纯文本、恢复屏蔽或切换邮件都会丢弃许可，不保存全局偏好。

许可通过受 Access 和精确 Origin 检查的 POST 获取，不能用一个带查询参数的 GET 链接开启。默认 HTML/元数据 GET 拒绝查询参数，避免其他页面用链接静默选择加载模式。

允许的来源仅使用无凭据、无自定义端口的公共 HTTPS URL；拒绝 IP 字面量、本地域、相对路径和本实例配置的入口 origin。POST 不接受任意 URL，只使用当前邮箱、当前邮件中经过清洗器提取的地址；没有匿名图片代理、可分享许可 URL 或额外 Worker。

图片获取仅调用全局 fetch，部署配置必须启用 `global_fetch_strictly_public`，防止同 zone 请求绕过公网入口直达源站。部署脚本会补齐旧配置中的该标志，配置检查拒绝相反的 `global_fetch_private_origin`。不使用 ASSETS、服务或 VPC 绑定代取图片；公网隔离依赖 Cloudflare 的运行时边界，不将 DNS 预检查误当成连接地址固定。[Cloudflare 公网 fetch 标志](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)、[绑定与公网访问边界](https://blog.cloudflare.com/workers-environment-live-object-bindings/)。将此代码移植到普通 Node 服务时，需要重新实现网络层的私网与 DNS 重绑定防护。

每次许可最多尝试剩余节点数对应的不同来源，逐个处理；单图最多 1 MiB，总下载受扣除 CID 后的 4 MiB 剩余预算限制，总操作限时 8 秒，每图最多 2 次重定向，每一跳重新执行 URL 校验。流式读取同时检查声明和实际字节数，拒绝错误状态、SVG/HTML、类型与魔数不符及超过 4096×4096/1600 万像素的画布。仅接受 PNG、JPEG、GIF 和 WebP；这不是恶意文件扫描或完整图片解码/转码。失败、超限或不支持的图片保持屏蔽，正文仍可阅读。

每个上游请求使用新建的固定请求头，不转发 Owner Cookie、Access JWT、Authorization、Origin 或 Referer，也不携带上游 Set-Cookie 到下一跳。不共享缓存或写入 D1/R2，不记录图片 URL 或返回上游错误正文。允许图片后的沙箱 CSP 只将 `img-src` 改为 `data:`，继续禁止 HTTPS 图片、连接、脚本和导航；邮件自带的 data URI 仍被丢弃。

代取仍会联系外部站点，包含跟踪参数的 URL 可以关联本次阅读时间，来源也会看到 Cloudflare 网络元数据。页面在确认时说明，不能将代取视为匿名保证。[Cloudflare 子请求头行为](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests)。

## Owner 接口

| 方法与路径 | 行为 |
| --- | --- |
| GET /owner/api/mailboxes/{id}/messages/{messageId}/html-info | 清洗并返回状态、blockedImages/remoteImages/loadedImages、inlineImages/loadedInlineImages 及链接，不含 HTML、图片字节或待取图片/CID 标识 |
| GET /owner/api/mailboxes/{id}/messages/{messageId}/html | 返回完整沙箱文档，显示安全 CID 图片，屏蔽远程图片 |
| POST 同一 /html | JSON `{allowRemoteImages:true}`，返回元数据及 `document` 字符串，仅供空沙箱 srcdoc |

所有路径重新验证 Owner、邮箱/邮件归属、未删除状态、正文对象用途、大小与 SHA-256。Owner 可以阅读已暂停邮箱；Token 不能调用这些 Owner 接口。POST 继续要求匹配 CONSOLE_ORIGIN，无匿名初始化或授权旁路。

`body.htmlStatus` 和 html-info 的 status 可为：

| 状态 | 含义 |
| --- | --- |
| available | HTML 可供清洗展示 |
| not_present | 已提取，邮件没有 HTML |
| not_extracted | 旧格式尚未提取 HTML |
| pending / failed | 邮件解析中 / 失败 |
| unavailable | 对象缺失、损坏、用途不符或不能安全处理 |
| too_large | 超出 HTML 展示预算 |

普通 getMessage 仅描述可用性，点击 HTML 后的完整清洗仍可能因复杂度或输出预算而拒绝。html-info 返回真实清洗结果；错误不包含原始 HTML、R2 key 或凭据。

`inlineImages` 为正文中通过语法检查的 CID 图片节点数，`loadedInlineImages` 为实际显示数量；`remoteImages` 为合格 HTTPS 来源节点数，`loadedImages` 仍仅统计实际显示的远程图片。`blockedImages` 统计所有仍被移除的图片节点。

## 本地验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

测试覆盖事件属性、脚本/表单/SVG/MathML、实体混淆 URL、恶意图片 alt、CSS 外部资源、异常标签、预算、旧正文和对象完整性，以及图片类型、尺寸、流大小、重定向和超时限制。CID 用例覆盖真实 multipart/related 收信、百分号解码、重复 ID、跨邮件/邮箱隔离、附件状态与 SHA-256、组合预算和 Token 权限。最终 Worker 验证 POST 图片许可不能被跨站或 GET 参数触发，API/MCP 保持文本输出。

浏览器验证切换 HTML 后内嵌 PNG 直接显示、缺失或 SVG CID 保持占位；开启远程图片后本地图片继续显示，恢复屏蔽只移除远程图片。没有 CORS 响应头的 PNG 经代取后也实际显示，浏览器没有外部图片请求；上游不含 Cookie、JWT、Origin 或 Referer。还验证清洗 DOM、沙箱不透明 origin、附件下载、已读状态不变、格式切换及每封邮件许可重置。使用已有 Playwright/Chrome，当前环境没有 Browser 插件。

未在真实 Cloudflare 邮箱部署或进行真实外部图片、邮件投递验收。旧邮件回填、精确还原发件人 CSS、通用附件预览仍未实现。HTML/文本双正文与 CID 发送另见[HTML 发送](html-sending.md)，草稿原始 HTML 可由授权主体编辑，但邮件读取 API/MCP 仍只返回文本。图片来源要求登录、反盗链验证或不支持所列格式时，仍可能无法显示。
