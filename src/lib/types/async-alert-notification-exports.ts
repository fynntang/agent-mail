import type {AlertNotificationDecisionList,AlertNotificationDecisionReason} from './alert-notification-decisions';
export type AsyncAlertNotificationExportState='queued'|'running'|'succeeded'|'failed'|'cancelled'|'expired';
export interface AsyncAlertNotificationExport {
  id:string;mailboxId:string;format:'csv'|'json';state:AsyncAlertNotificationExportState;version:number;
  window:{from:number;to:number};filters:{decision:'all'|AlertNotificationDecisionReason;eventType:'all'|'created'|'resolved'};
  snapshot:{decisionWatermark:number};totalDecisions:number;processedDecisions:number;processedDeliveries:number;chunkCount:number;bodyBytes:number;
  summary:AlertNotificationDecisionList['summary'];createdAt:number;updatedAt:number;startedAt:number|null;completedAt:number|null;expiresAt:number;
  observedFrom:number|null;observedTo:number|null;errorCode:string|null;canCancel:boolean;downloadAvailable:boolean;
}
export interface AsyncAlertNotificationExportList {jobs:AsyncAlertNotificationExport[];nextCursor:string|null}
