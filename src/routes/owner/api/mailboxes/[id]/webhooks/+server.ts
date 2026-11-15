import {webhookApi} from '#lib/server/svelte/webhook-api.ts';
export const GET=webhookApi('endpoints.list',true);
export const POST=webhookApi('endpoints.create',true);
