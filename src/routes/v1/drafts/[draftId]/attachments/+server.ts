import {draftAttachmentApi} from '#lib/server/svelte/draft-attachment-api.ts';
export const GET=draftAttachmentApi('list',false);
export const POST=draftAttachmentApi('upload',false);
