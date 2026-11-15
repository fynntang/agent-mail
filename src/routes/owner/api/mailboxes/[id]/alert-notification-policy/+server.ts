import {alertNotificationPolicyApi} from '#lib/server/svelte/alert-notification-policy-api.ts';
export const GET=alertNotificationPolicyApi('get');
export const PATCH=alertNotificationPolicyApi('update');
