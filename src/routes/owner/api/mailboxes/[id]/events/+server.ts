import {webhookApi} from '#lib/server/svelte/webhook-api.ts';
export const GET=webhookApi('events.list',true);
