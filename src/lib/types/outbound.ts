/** Safe outbound DTOs. Credentials, R2 keys and raw provider responses stay server-side. */
export interface DraftAttachmentRef {
  id:string;
  filename:string;
  contentType:string;
  sizeBytes:number;
  sha256:string;
}
export interface DraftInlineImage {attachmentId:string;contentId:string}
export interface DraftContent {
  to:string[];
  cc:string[];
  bcc:string[];
  subject:string;
  text:string;
  replyMessageId:string|null;
  inReplyTo:string|null;
  /** Absent on legacy draft/snapshot content so existing signed hashes remain valid. */
  attachments?:DraftAttachmentRef[];
  /** Raw outbound HTML. Owner previews are sanitized separately; null explicitly clears HTML. */
  html?:string|null;
  /** Same-draft attachment identities bound to exact, case-sensitive Content-IDs. */
  inlineImages?:DraftInlineImage[];
}
export type DraftState='editing'|'awaiting_approval'|'approved'|'submitted'|'discarded';
export interface DraftDTO {
  id:string;
  mailboxId:string;
  version:number;
  state:DraftState;
  contentSha256:string;
  createdByTokenId:string|null;
  requiresApproval:boolean;
  createdAt:number;
  updatedAt:number;
  content:DraftContent;
}
export type DraftSummary=Omit<DraftDTO,'content'>&{content?:DraftContent;subject?:string};
export interface OutboundSummary {
  id:string;
  draftId:string;
  status:'queued'|'submitting'|'accepted'|'partial'|'delivered'|'bounced'|'failed'|'cancelled'|'unknown';
  providerMessageId:string|null;
  lastErrorCode:string|null;
  createdAt:number;
  lastProviderEventAt:number|null;
  recipients:{kind:'to'|'cc'|'bcc';address:string;
    status:'queued'|'accepted'|'deferred'|'delivered'|'bounced'|'failed'|'unknown';
    lastProviderEventAt:number|null;
    deliveryEventType:'delivered'|'deferred'|'bounced'|'failed'|'rejected'|'complained'|null;
    complainedAt:number|null;diagnosticCode:string|null}[];
}
