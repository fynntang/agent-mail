import type {WebhookDelivery} from './webhooks';

export type AlertNotificationDecisionReason='allowed'|'disabled'|'quiet_hours'|'repeat_limited'|'recovery_disabled'|'no_subscribers';
export interface AlertNotificationDeliverySummary {
  total:number;pending:number;running:number;succeeded:number;dead:number;cancelled:number;attempts:number;quietDeferred:number;
}
export interface AlertNotificationDecision {
  eventId:string;alertId:string;decision:AlertNotificationDecisionReason;policyVersion:number;decidedAt:number;
  eventAvailable:boolean;eventType:'created'|'resolved'|null;kind:'sync'|'release'|null;
  outcome:'failed'|'unknown'|'resolved'|null;errorCode:string|null;occurredAt:number|null;
  delivery:AlertNotificationDeliverySummary;
}
export interface AlertNotificationDecisionList {
  decisions:AlertNotificationDecision[];nextCursor:string|null;window:{from:number;to:number};
  summary:{total:number;allowed:number;skipped:number;byDecision:Record<AlertNotificationDecisionReason,number>;delivery:AlertNotificationDeliverySummary};
}
export interface AlertNotificationDecisionDetail {
  decision:AlertNotificationDecision;deliveries:WebhookDelivery[];deliveriesTruncated:boolean;
}
