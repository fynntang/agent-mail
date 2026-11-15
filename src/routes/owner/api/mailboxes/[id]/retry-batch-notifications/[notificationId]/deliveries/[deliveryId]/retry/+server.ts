import {retryBatchNotificationDeliveriesApi} from '#lib/server/svelte/retry-batch-notification-deliveries-api.ts';
export const POST=retryBatchNotificationDeliveriesApi('retry');
