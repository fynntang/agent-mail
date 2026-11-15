import { listMailboxes, requireOwner } from '#lib/server/core/owner.ts';
import { ownerContext } from '#lib/server/svelte/owner.ts';
import type { LayoutServerLoad } from './$types';
import type {MailboxSummary} from '#lib/types/owner.ts';
import {suppressionAlertNotice} from '#lib/server/core/cloudflare-suppression-alert-notice.ts';
import {exportNotice} from '#lib/server/core/async-export-notifications.ts';
import {retryBatchNotice} from '#lib/server/core/retry-batch-notifications.ts';

export const load:LayoutServerLoad=async({locals,route})=>{
  const ctx=ownerContext(locals);
  const owner=requireOwner(ctx.actor);
  let mailboxes:MailboxSummary[];
  try {mailboxes=await listMailboxes(ctx);}
  catch(error){
    // The authenticated setup page must remain reachable when it is diagnosing a broken/unmigrated DB.
    if(route.id!=='/owner/setup')throw error;
    mailboxes=[];
  }
  let notice:null|{count:number;mailboxId:string}=null;
  try{notice=await suppressionAlertNotice(ctx);}
  catch{console.error(JSON.stringify({event:'suppression_alert_notice_unavailable'}));}
  let exportNotificationNotice:null|{count:number;mailboxId:string}=null;
  try{exportNotificationNotice=await exportNotice(ctx);}
  catch{console.error(JSON.stringify({event:'async_export_notice_unavailable'}));}
  let retryBatchNotificationNotice:null|{count:number;attentionCount:number;mailboxId:string}=null;
  try{retryBatchNotificationNotice=await retryBatchNotice(ctx);}
  catch{console.error(JSON.stringify({event:'retry_batch_notice_unavailable'}));}
  return {ownerEmail:owner.email,mailDomain:ctx.env.MAIL_DOMAIN,mailboxes,suppressionAlertNotice:notice,exportNotificationNotice,retryBatchNotificationNotice};
};
