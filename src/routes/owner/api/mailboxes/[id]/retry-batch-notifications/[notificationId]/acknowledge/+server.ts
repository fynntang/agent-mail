import {retryBatchNotificationsApi} from '#lib/server/svelte/retry-batch-notifications-api.ts';
export const POST=retryBatchNotificationsApi('acknowledge');
