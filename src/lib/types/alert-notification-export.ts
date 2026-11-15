import type {AlertNotificationDecision,AlertNotificationDecisionList,AlertNotificationDecisionReason} from './alert-notification-decisions';
import type {WebhookDelivery} from './webhooks';

export interface AlertNotificationExport {
  version:1;generatedAt:number;mailboxId:string;window:{from:number;to:number};
  filters:{decision:'all'|AlertNotificationDecisionReason;eventType:'all'|'created'|'resolved'};
  snapshot:{decisionWatermark:number};summary:AlertNotificationDecisionList['summary'];
  decisions:(AlertNotificationDecision&{deliveries:WebhookDelivery[]})[];
}
export interface AlertNotificationExportQuery {decision?:unknown;eventType?:unknown;from?:unknown;to?:unknown}
