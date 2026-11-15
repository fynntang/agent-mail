import {webhookApi} from '#lib/server/svelte/webhook-api.ts';
export const POST=webhookApi('delivery.retry',true);
