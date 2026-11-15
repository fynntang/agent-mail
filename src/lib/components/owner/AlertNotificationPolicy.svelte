<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {AlertNotificationPolicy as Policy} from '#lib/types/alert-notification-policy.ts';
  let {mailboxId}:{mailboxId:string}=$props();
  let policy=$state<Policy|null>(null),expanded=$state(false),loading=$state(true),busy=$state(false),errorMessage=$state(''),notice=$state(''),requiresReload=$state(false);
  let enabled=$state(true),recoveryEnabled=$state(true),repeatIntervalSeconds=$state(0),quietEnabled=$state(false),quietStart=$state('22:00'),quietEnd=$state('08:00'),timeZone=$state('UTC');
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/alert-notification-policy`),controller=new AbortController();
  const summary=$derived(policy?`${policy.enabled?'通知已开启':'通知已关闭'} · ${policy.recoveryEnabled?'发送恢复通知':'不发送恢复通知'} · ${policy.repeatIntervalSeconds===0?'重复提醒不限频':`重复提醒间隔 ${interval(policy.repeatIntervalSeconds)}`}`:'');
  onMount(()=>{void load();});onDestroy(()=>controller.abort());
  function clock(value:number):string {return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;}
  function minute(value:string):number {const match=/^(\d{2}):(\d{2})$/.exec(value);return match?Number(match[1])*60+Number(match[2]):NaN;}
  function interval(value:number):string {return value%86400===0?`${value/86400} 天`:value%3600===0?`${value/3600} 小时`:value%60===0?`${value/60} 分钟`:`${value} 秒`;}
  function apply(value:Policy) {policy=value;enabled=value.enabled;recoveryEnabled=value.recoveryEnabled;repeatIntervalSeconds=value.repeatIntervalSeconds;quietEnabled=value.quietEnabled;quietStart=clock(value.quietStartMinute);quietEnd=clock(value.quietEndMinute);timeZone=value.timeZone;requiresReload=false;}
  async function load() {
    if(busy)return;busy=true;errorMessage='';notice='';
    try{const result=await ownerRequest<{policy:Policy}>(base,{signal:controller.signal});if(!controller.signal.aborted)apply(result.policy);}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'通知策略读取失败，请刷新重试。';}
    finally{if(!controller.signal.aborted){busy=false;loading=false;}}
  }
  async function save(event:SubmitEvent) {
    event.preventDefault();if(busy||!policy||requiresReload)return;errorMessage='';notice='';
    const start=minute(quietStart),end=minute(quietEnd);
    if(!Number.isSafeInteger(repeatIntervalSeconds)||repeatIntervalSeconds<0||repeatIntervalSeconds>604800
      ||!Number.isInteger(start)||!Number.isInteger(end)||start<0||start>1439||end<0||end>1439||quietEnabled&&start===end){errorMessage='请检查通知间隔和静默时段；开启静默时，开始与结束时间不能相同。';return;}
    busy=true;
    try{
      const result=await ownerRequest<{policy:Policy}>(base,{method:'PATCH',body:{expectedVersion:policy.version,enabled,recoveryEnabled,repeatIntervalSeconds,quietEnabled,quietStartMinute:start,quietEndMinute:end,timeZone:timeZone.trim()},signal:controller.signal});
      if(!controller.signal.aborted){apply(result.policy);notice='通知策略已保存。控制台告警记录保持完整。';}
    }catch(error){if(!controller.signal.aborted){errorMessage=error instanceof Error?error.message:'通知策略保存失败，请刷新核对。';requiresReload=errorMessage.includes('策略已变化')||errorMessage.includes('结果不确定');}}
    finally{if(!controller.signal.aborted)busy=false;}
  }
</script>

<div class="alert-policy" aria-label="告警通知策略">
  <div class="policy-summary"><div><strong>告警通知策略</strong>{#if policy}<p>{summary}</p>{#if policy.quietEnabled}<p>每日静默 {clock(policy.quietStartMinute)}–{clock(policy.quietEndMinute)} · {policy.timeZone}</p>{/if}{:else if loading}<p role="status">正在读取通知策略…</p>{/if}</div><button type="button" aria-expanded={expanded} aria-controls="alert-policy-form" disabled={loading} onclick={()=>expanded=!expanded}>{expanded?'收起通知策略':'配置通知策略'}</button></div>
  {#if !expanded&&errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
  {#if !expanded&&notice}<div class="notice" role="status">{notice}</div>{/if}
  {#if expanded}
    <form id="alert-policy-form" aria-label="告警通知策略设置" onsubmit={save}>
      <p class="policy-help">仅影响此邮箱的告警 Webhook 和异步导出 Webhook，控制台告警、导出提醒与执行历史完整保留。普通邮件事件通知不受影响。导出完成与失败复用通知开关、静默时段和重复限频；“发送恢复通知”只影响故障恢复事件。</p>
      <fieldset disabled={busy||!policy}>
        <legend class="sr-only">通知方式</legend>
        <label class="policy-check"><input type="checkbox" bind:checked={enabled}/>开启告警 Webhook 通知</label>
        <label class="policy-check"><input type="checkbox" bind:checked={recoveryEnabled}/>发送恢复通知</label>
        <div class="policy-grid">
          <div class="field"><label for="alert-repeat-interval">重复提醒间隔（秒）</label><input id="alert-repeat-interval" type="number" min="0" max="604800" step="1" required bind:value={repeatIntervalSeconds}/><small>0 表示不限频；1800 为30分钟，最多7天。同一告警的相同结果和错误码受限频。</small></div>
          <div class="field"><label for="alert-time-zone">静默时区</label><input id="alert-time-zone" type="text" required maxlength="64" placeholder="Asia/Shanghai" bind:value={timeZone}/><small>使用 IANA 时区名称，例如 Asia/Shanghai 或 UTC。</small></div>
        </div>
        <label class="policy-check"><input type="checkbox" bind:checked={quietEnabled}/>启用每日静默时段</label>
        <div class="policy-grid policy-times"><div class="field"><label for="alert-quiet-start">静默开始</label><input id="alert-quiet-start" type="time" required disabled={!quietEnabled} bind:value={quietStart}/></div><div class="field"><label for="alert-quiet-end">静默结束</label><input id="alert-quiet-end" type="time" required disabled={!quietEnabled} bind:value={quietEnd}/></div></div>
        <p class="policy-help">支持跨午夜，例如22:00–08:00。新通知在关闭、静默或限频时跳过，不自动补发。已有待投递通知在静默期顺延，关闭通知会取消尚未完成的告警投递。</p>
      </fieldset>
      {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
      {#if notice}<div class="notice" role="status">{notice}</div>{/if}
      <div class="policy-actions"><button class="primary" type="submit" disabled={busy||!policy||requiresReload}>{busy?'处理中…':'保存通知策略'}</button><button type="button" disabled={busy} onclick={load}>重新读取策略</button></div>
    </form>
  {:else if !policy&&!loading}<button type="button" disabled={busy} onclick={load}>重新读取策略</button>{/if}
</div>

<style>
  .alert-policy{margin:17px 0 8px;padding-top:15px;border-top:1px solid var(--line);}
  .policy-summary,.policy-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
  .policy-summary strong{font-size:13px;}.policy-summary p,.policy-help{font-size:12px;line-height:1.7;margin:4px 0;overflow-wrap:anywhere;}
  .policy-summary button,.policy-actions button{font-size:12px;min-height:34px;padding:6px 11px;}
  form{margin-top:15px;padding:15px;border:1px solid var(--line);border-radius:7px;background:var(--surface);}
  fieldset{margin:14px 0;padding:0;border:0;min-width:0;}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
  .policy-check{display:flex;align-items:center;gap:8px;margin:12px 0;font-size:13px;}
  .policy-check input{width:17px;height:17px;flex-shrink:0;}
  .policy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin-top:17px;}
  .policy-grid .field{margin-bottom:0;}.policy-grid label{font-size:12px;}.policy-grid small{font-size:11px;}
  .policy-actions{justify-content:flex-start;margin-top:15px;}
  .notice{margin-top:12px;font-size:12px;}
  @media(max-width:800px){form{padding:12px;}.policy-grid{grid-template-columns:minmax(0,1fr);gap:14px;}.policy-times{grid-template-columns:repeat(2,minmax(0,1fr));}.policy-summary{align-items:flex-start;}}
</style>
