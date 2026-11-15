const messages:Record<string,string>={
  cloudflare_recipient_suppressed:'Cloudflare 已抑制此收件人，整封邮件未发送。请由 Owner 核对服务端名单。',
  cloudflare_suppressions_not_configured:'尚未配置 Cloudflare 抑制管理。请按部署说明设置专用 Worker secret、账户及发信域名。',
  cloudflare_suppression_read_only:'Cloudflare 将此记录标为只读，不能通过本实例解除。',
  cloudflare_suppression_changed:'服务端记录已变化，请同步名单后重新核对。',
  cloudflare_suppression_busy:'另一项同步或解除正在进行，请稍后刷新查看结果。',
  alert_changed:'提醒已发生变化，请关闭并刷新后重新确认。',
  alert_notification_policy_changed:'通知策略已变化，请重新读取后核对并保存。',
  invalid_alert_notification_policy:'通知策略无效，请检查开关、间隔、静默时段和 IANA 时区。',
  alert_notification_export_too_large:'导出内容超过上限，请缩小时间范围或筛选条件后重试。',
  invalid_async_export:'后台导出条件无效，请检查格式、时间范围和筛选。',
  async_export_idempotency_conflict:'本次创建标识已对应另一份任务，请刷新列表核对后重新创建。',
  async_export_quota_exceeded:'进行中的后台导出任务已达上限，请等待完成或取消后再创建。',
  async_export_changed:'后台任务已变化，请刷新状态后重新操作。',
  async_export_not_cancellable:'此任务已结束，不能继续取消，请刷新状态。',
  async_export_too_large:'后台导出超过任务上限，请缩小范围后重新创建。',
  async_export_expired:'临时导出文件已过期，请重新创建任务。',
  export_notification_changed:'导出通知已变化，请刷新后重新确认。',
  retry_batch_notification_retry_unavailable:'此批量任务通知当前不能重新排队，请刷新核对原准入、当前通知策略、投递状态和历史签名配置。',
  retry_batch_notification_retry_changed:'投递记录已变化，请刷新核对最新结果后重新决定。',
  retry_batch_notification_retry_conflict:'本次重试标识已用于其他条件，请核对原操作后重新开始。',
  retry_batch_notification_changed:'批量任务通知已变化，请刷新后重新确认。',
  export_notification_retry_unavailable:'此通知投递当前不能重新排队，请刷新核对通知策略、投递状态和签名配置。',
  export_notification_retry_changed:'投递记录已变化，请刷新核对最新结果后重新决定。',
  export_notification_retry_conflict:'本次重试标识已用于其他条件，请核对原操作后重新开始。',
  batch_retry_invalid:'批量重试条件无效，请检查时间范围、失败原因和操作标识。',
  batch_retry_too_large:'候选投递超过1000条，请缩小时间范围或选择更具体的失败原因。',
  batch_retry_expired:'预览或批次已过期，请重新生成预览并核对。',
  batch_retry_changed:'批次状态或版本已变化，请刷新核对后重新决定。',
  batch_retry_conflict:'本次批量操作标识已用于不同条件，请先核对原记录。',
  batch_retry_quota:'当前邮箱不可提交，或批量任务及预览已达上限。请刷新核对邮箱状态和已有批次。',
  batch_control_invalid:'批次控制条件无效，请检查操作标识和待核对条目。',
  batch_control_changed:'批次或条目已变化，请刷新核对原操作历史后重新决定。',
  batch_control_conflict:'本次操作标识已用于其他条件，请沿原条件核对操作历史。',
  batch_control_unavailable:'此批次当前不能执行该操作，请刷新核对状态和未知结果。',
  cloudflare_suppression_unavailable:'Cloudflare 暂时无法访问或响应无效，已有缓存和本地抑制保持保留。',
  recipient_suppressed:'收件人已因永久退信或投诉被此邮箱抑制，整封邮件未发送。请由 Owner 核实并解除抑制后重新提交。',
  suppression_changed:'抑制记录已变化，请刷新后核对最新状态，再决定是否解除。',
  suppression_not_active:'此记录已经解除抑制，请刷新名单。',
  webhooks_not_configured:'Webhook 签名加密密钥尚未配置，请按本页部署说明设置 WEBHOOK_KEYRING。',
  webhook_secret_unavailable:'无法解密此投递的历史签名密钥，请恢复对应的包装密钥。',
  invalid_webhook_url:'回调地址必须是公共 HTTPS 地址，不能使用凭据、IP、本地域、端口或本实例入口。',
  invalid_event_types:'请至少选择一个支持的邮件事件。',webhook_changed:'订阅或投递记录已变化，请刷新后重试。',
  webhook_endpoint_limit:'此邮箱最多保留 10 个未禁用订阅和 100 个历史订阅。',webhook_disabled:'订阅已禁用或状态无效，请新建订阅。',
  webhook_retry_unavailable:'此投递暂不可重试：仅支持活动订阅的失败记录，且总预算不得超过 80 次。',
  invalid_name:'请输入 1–80 个字符的名称。',invalid_address:'请输入有效的邮箱前缀，使用英文字母、数字或常用邮箱符号。',
  address_unavailable:'这个地址已被使用或已退役，请换一个地址。',mailbox_changed:'邮箱已被其他页面修改，请刷新后再试。',
  invalid_message_size:'邮件大小上限需在 1 KiB 到 10 MiB 之间。',mailbox_inactive:'邮箱已暂停，恢复后才可执行此操作。',
  unsupported_scopes:'请选择有效权限；发信权限需同时授予草稿权限。',invalid_expiry:'请选择有效的到期时间。',
  address_confirmation_required:'请输入完整邮箱地址以确认退役。',not_found:'请求的邮箱、邮件、草稿或 Token 不存在，可能已删除或退役。',
  invalid_cursor:'分页位置无效或已不适用，请返回第一页。',invalid_query:'分页或筛选条件无效，请返回第一页。',
  mail_domain_not_configured:'实例的收信域名尚未配置，请联系部署者。',invalid_input:'提交内容无效，请检查后重试。',
  invalid_recipients:'请输入有效的收件人地址。',recipient_not_allowed:'收件人不在此邮箱允许发送的地址列表中。',
  invalid_subject:'主题包含不支持的字符或超过长度限制。',invalid_body:'正文无效或超过大小限制。',
  invalid_daily_limit:'每日收件人数上限需为 0–1000 的整数。',invalid_allowed_recipients:'允许的收件人最多 100 个，请填写完整邮箱地址。',
  draft_changed:'草稿版本已更新，请重新打开草稿并核对内容。',draft_not_editable:'此草稿已提交或不能修改，请新建草稿。',
  approval_required:'需要 Owner 核对并审批当前版本，审批后再提交发送。',approval_expired:'审批已失效，请重新核对当前版本。',
  daily_limit_exceeded:'已达到每日收件人数上限，请稍后再试或调整邮箱设置。',send_limit_exceeded:'已达到此邮箱的发送限额。',
  idempotency_conflict:'这次发送请求的内容与先前请求不同，请刷新核对。',send_not_cancellable:'邮件已开始提交，无法保证取消，请刷新查看状态。',
  sending_not_configured:'邮件发送服务尚未配置，请联系部署者。',sending_disabled:'此邮箱当前禁止发送邮件。',
  invalid_approval_policy:'仅有发信权限的 Token 可以设置发送审批策略。'
};
Object.assign(messages,{
  invalid_recipient:'请输入完整有效的收件人邮箱地址。',too_many_recipients:'每封邮件最多包含 50 个收件人（含抄送和密送）。',
  invalid_text:'正文包含不支持的字符，或 UTF-8 大小超过 64 KiB。',invalid_reply:'无法引用此邮件，请从阅读页面重新创建回复。',
  incomplete_draft:'发送前请填写收件人、主题和文本正文。',invalid_daily_recipient_limit:messages.invalid_daily_limit,
  content_unavailable:'草稿正文暂不可用，请刷新后重试。',content_corrupt:'草稿内容校验失败，请重新创建草稿。',
  insufficient_scope:'发起此草稿的 Token 已失效或缺少所需权限，请检查 Token 设置。',
  pending_sends:'邮箱仍有排队、提交中或结果未知的发送，请处理后再退役。'
});
Object.assign(messages,{
  setup_changed:'初始化记录已被其他页面修改，请刷新后重新核对。',
  setup_config_changed:'部署配置已变化，请刷新后按当前配置重新确认。',
  setup_incomplete:'初始化条件尚未完成，请检查配置、资源、邮箱和所有适用的人工确认。',
  setup_probe_failed:'存储读写检查失败，请检查 R2 绑定及权限。',
  invalid_display_name:'请输入 1–80 个字符的实例名称。'
});

export async function ownerRequest<T>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal;idempotencyKey?:string}={}):Promise<T> {
  if(!path.startsWith('/owner/api/')) throw new Error('管理接口地址无效。');
  let response:Response;
  try {
    response=await fetch(path,{method:options.method??'GET',credentials:'same-origin',redirect:'manual',cache:'no-store',signal:options.signal,
      headers:{Accept:'application/json',...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.idempotencyKey?{'Idempotency-Key':options.idempotencyKey}:{})},
      body:options.body===undefined?undefined:JSON.stringify(options.body)});
  } catch {throw new Error('请求未完成，请检查网络或重新登录。结果不确定时，请刷新确认后再操作。');}
  if(response.status===204) return undefined as T;
  if(response.type==='opaqueredirect' || response.status===401
    || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('登录状态已失效，请重新打开控制台登录。');
  }
  let data:unknown;
  try {data=await response.json();} catch {throw new Error('无法读取响应，请刷新后重试。');}
  if(!response.ok) {
    const code=(data as {error?:{code?:string}})?.error?.code??'';
    throw new Error(messages[code]??(code==='owner_not_configured'?'Owner 认证尚未配置。':response.status===403?'没有执行此操作的权限，请检查登录状态和邮箱策略。':'操作未完成，请稍后重试。'));
  }
  return data as T;
}

export function dateLabel(value:number|null):string {
  return value===null?'永不过期':new Date(value).toISOString().slice(0,10);
}

/** Downloads remain on the authenticated Owner origin; login pages and oversized bodies never become files. */
export async function ownerDownload(path:string,format:'csv'|'json',signal?:AbortSignal):Promise<Blob>{
  if(!path.startsWith('/owner/api/'))throw new Error('管理接口地址无效。');
  const mime=format==='csv'?'text/csv':'application/json',maximum=8*1024*1024;
  let response:Response;
  try{response=await fetch(path,{credentials:'same-origin',redirect:'manual',cache:'no-store',signal,headers:{Accept:mime}});}
  catch{throw new Error(signal?.aborted?'导出已取消。':'导出未完成，请检查网络或重新登录。');}
  if(response.type==='opaqueredirect'||response.status===401){void response.body?.cancel();throw new Error('登录状态已失效，请重新打开控制台登录。');}
  if(!response.ok){
    let data:{error?:{code?:string}}={};try{if(response.headers.get('content-type')?.includes('application/json'))data=await response.json();}catch{/* Never expose an upstream body. */}
    const code=data.error?.code??'';
    throw new Error(messages[code]??(response.status===403?'没有执行此操作的权限，请检查登录状态和邮箱策略。':'导出未完成，请稍后重试。'));
  }
  if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!==mime||!/^attachment(?:;|$)/i.test(response.headers.get('content-disposition')??'')){
    void response.body?.cancel();throw new Error('无法读取导出响应，请重新登录或刷新后重试。');
  }
  if(Number(response.headers.get('content-length'))>maximum){void response.body?.cancel();throw new Error(messages.alert_notification_export_too_large);}
  const parts:ArrayBuffer[]=[],reader=response.body?.getReader();let size=0;
  if(!reader)throw new Error('无法读取导出响应，请刷新后重试。');
  try{
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maximum){await reader.cancel();throw new Error(messages.alert_notification_export_too_large);}parts.push(new Uint8Array(chunk.value).buffer);}
  }catch(error){if(signal?.aborted)throw new Error('导出已取消。');throw error instanceof Error?error:new Error('导出下载中断，请重试。');}
  finally{reader.releaseLock();}
  return new Blob(parts,{type:mime});
}
