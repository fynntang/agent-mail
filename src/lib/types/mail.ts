export type MailFolder='all'|'inbox'|'sent'|'archive'|'trash'|'spam';
export type ReadFilter='all'|'read'|'unread';
export interface MessageQuery {
  limit:number;
  folder:MailFolder;
  read:ReadFilter;
  cursor?:string;
  q?:string;
}
export interface MessageSummary {
  id:string;
  subject:string|null;
  preview:string|null;
  direction:'inbound'|'outbound';
  folder:Exclude<MailFolder,'all'>;
  is_read:0|1;
  parse_state:'pending'|'ready'|'failed';
  size_bytes:number;
  received_at:number;
  from:{address:string;name:string|null}|null;
}
export interface MessagePage {
  messages:MessageSummary[];
  limit:number;
  filters:{folder:MailFolder;read:ReadFilter;q?:string};
  nextCursor:string|null;
  previousCursor:string|null;
}
export interface MessageAddress {
  kind:'from'|'sender'|'reply_to'|'to'|'cc'|'bcc'|'envelope_to';
  address:string;
  name:string|null;
}
export interface MessageDetail {
  message:MessageSummary;
  addresses:MessageAddress[];
  body:{status:'ready'|'empty'|'not_extracted'|'pending'|'failed'|'unavailable';text:string|null;htmlStatus:HtmlBodyStatus};
  attachments:AttachmentList;
  capabilities:{htmlRendering:boolean;attachmentExtraction:true};
}

export type HtmlBodyStatus='available'|'not_present'|'not_extracted'|'pending'|'failed'|'unavailable'|'too_large';
/** Only the Owner-specific service may return cleaned markup; ordinary message DTOs never contain it. */
export interface OwnerMessageHtml {
  status:HtmlBodyStatus;
  html:string|null;
  blockedImages:number;
  remoteImages:number;
  loadedImages:number;
  inlineImages:number;
  loadedInlineImages:number;
  links:{label:string;url:string}[];
}

export interface AttachmentSummary {
  id:string;
  messageId:string;
  filename:string;
  sizeBytes:number;
  contentType:string;
  disposition:'attachment'|'inline';
  contentId:string|null;
  scanStatus:'unscanned'|'clean'|'blocked'|'failed';
  downloadable:boolean;
}
export interface AttachmentList {
  status:'ready'|'not_extracted'|'pending'|'failed';
  canDownload:boolean;
  attachments:AttachmentSummary[];
}
