import { runScheduled } from '../../src/lib/server/core/jobs';
import { runSendJobs } from '../../src/lib/server/core/outbound-jobs';
import { runWebhookJobs } from '../../src/lib/server/core/webhook-jobs';
import { runDeliveryEventJobs } from '../../src/lib/server/core/delivery-events';
import {runCloudflareSuppressionSync} from '../../src/lib/server/core/cloudflare-suppressions';
import {projectCloudflareSuppressionAlerts} from '../../src/lib/server/core/cloudflare-suppression-alerts';
import {runAsyncAlertNotificationExportJobs} from '../../src/lib/server/core/async-alert-notification-export-jobs';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {runAsyncExportNotificationRetryBatchJobs} from '../../src/lib/server/core/async-export-notification-retry-batch-jobs';
import {projectRetryBatchNotifications} from '../../src/lib/server/core/retry-batch-notifications';
import type { RuntimeEnv } from '../../src/lib/server/core/types';

export async function handleScheduled(_controller: ScheduledController, env: RuntimeEnv): Promise<void> {
  const result = await runScheduled(env);
  const providerSuppressions=await runCloudflareSuppressionSync(env);
  let alerts={suppressionAlertsProjected:0};
  try{alerts=await projectCloudflareSuppressionAlerts(env);}
  catch{console.error(JSON.stringify({event:'suppression_alert_projection_failed'}));}
  const priorDeliveries=await runDeliveryEventJobs(env);
  const sends = await runSendJobs(env);
  const deliveries=await runDeliveryEventJobs(env);
  const webhooks=await runWebhookJobs(env);
  let batchRetries={batchRetryProcessed:0,batchRetryRequeued:0,batchRetrySkipped:0,batchRetryFailed:0,batchRetryUnknown:0,batchRetryReconciled:0};
  try{batchRetries=await runAsyncExportNotificationRetryBatchJobs(env);}
  catch{console.error(JSON.stringify({event:'export_notification_retry_batches_unavailable'}));}
  let retryBatchNotifications={retryBatchNotificationsProjected:0};
  try{retryBatchNotifications=await projectRetryBatchNotifications(env);}
  catch{console.error(JSON.stringify({event:'retry_batch_notifications_unavailable'}));}
  let exports={asyncExportsProcessed:0,asyncExportsCompleted:0,asyncExportsFailed:0,asyncExportsExpired:0,asyncExportsCleaned:0};
  try{exports=await runAsyncAlertNotificationExportJobs(env);}
  catch{console.error(JSON.stringify({event:'async_export_jobs_unavailable'}));}
  let exportNotifications={exportNotificationsProjected:0};
  try{exportNotifications=await projectAsyncExportNotifications(env);}
  catch{console.error(JSON.stringify({event:'async_export_notifications_unavailable'}));}
  console.info(JSON.stringify({event:'scheduled_completed',...result,...sends,...providerSuppressions,...alerts,
    deliveryEventsApplied:priorDeliveries.deliveryEventsApplied+deliveries.deliveryEventsApplied,
    deliveryEventsIgnored:priorDeliveries.deliveryEventsIgnored+deliveries.deliveryEventsIgnored,
    deliveryEventsPending:priorDeliveries.deliveryEventsPending+deliveries.deliveryEventsPending,...webhooks,...batchRetries,...retryBatchNotifications,...exports,...exportNotifications}));
}
