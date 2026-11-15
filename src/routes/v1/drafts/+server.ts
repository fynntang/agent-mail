import {outboundApi} from '#lib/server/svelte/outbound-api.ts';
export const GET=outboundApi('drafts.list',false);
export const POST=outboundApi('drafts.create',false);
