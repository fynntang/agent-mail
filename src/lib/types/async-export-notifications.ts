export type AsyncExportNotificationDecision='allowed'|'disabled'|'quiet_hours'|'repeat_limited'|'no_subscribers';
export interface AsyncExportNotification {
  id:string;jobId:string;mailboxId:string;outcome:'succeeded'|'failed';format:'csv'|'json';
  totalDecisions:number;processedDecisions:number;processedDeliveries:number;bodyBytes:number;errorCode:string|null;
  completedAt:number;expiresAt:number;createdAt:number;acknowledgedAt:number|null;version:number;
  notificationDecision:AsyncExportNotificationDecision|null;policyVersion:number|null;decidedAt:number|null;
}
export interface AsyncExportNotificationList {
  notifications:AsyncExportNotification[];nextCursor:string|null;summary:{unread:number;succeeded:number;failed:number};
}
