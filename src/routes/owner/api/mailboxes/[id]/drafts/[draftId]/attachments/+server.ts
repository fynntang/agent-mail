import {draftAttachmentApi} from '#lib/server/svelte/draft-attachment-api.ts';
export const GET=draftAttachmentApi('list',true);
export const POST=draftAttachmentApi('upload',true);
