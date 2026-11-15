import {outboundApi} from '#lib/server/svelte/outbound-api.ts';
export const GET=outboundApi('draft.get',false);
export const PATCH=outboundApi('draft.update',false);
export const DELETE=outboundApi('draft.discard',false);
