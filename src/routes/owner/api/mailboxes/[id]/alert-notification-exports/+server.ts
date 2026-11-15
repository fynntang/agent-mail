import {asyncAlertNotificationExportsApi} from '#lib/server/svelte/async-alert-notification-exports-api.ts';
export const GET=asyncAlertNotificationExportsApi('list');
export const POST=asyncAlertNotificationExportsApi('create');
