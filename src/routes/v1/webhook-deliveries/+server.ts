import {webhookApi} from '#lib/server/svelte/webhook-api.ts';
export const GET=webhookApi('deliveries.list',false);
