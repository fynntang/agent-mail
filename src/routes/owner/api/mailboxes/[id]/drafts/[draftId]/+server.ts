import {outboundApi} from '#lib/server/svelte/outbound-api.ts';
export const GET=outboundApi('draft.get',true);
export const PATCH=outboundApi('draft.update',true);
export const DELETE=outboundApi('draft.discard',true);
