import {asyncAlertNotificationExportsApi} from '#lib/server/svelte/async-alert-notification-exports-api.ts';
export const GET=asyncAlertNotificationExportsApi('download');
export const HEAD=asyncAlertNotificationExportsApi('download');
