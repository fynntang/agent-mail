import {cloudflareSuppressionAlertsApi} from '#lib/server/svelte/cloudflare-suppression-alerts-api.ts';
export const POST=cloudflareSuppressionAlertsApi('acknowledge');
