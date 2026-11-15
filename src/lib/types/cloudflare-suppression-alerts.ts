export type CloudflareSuppressionAlertStatus='open'|'acknowledged'|'resolved';
export type CloudflareSuppressionAlertOutcome='failed'|'unknown'|'resolved';
export interface CloudflareSuppressionAlert {
  id:string;kind:'sync'|'release';status:CloudflareSuppressionAlertStatus;outcome:CloudflareSuppressionAlertOutcome;
  version:number;generation:number;occurrences:number;errorCode:string|null;
  firstOccurredAt:number;lastOccurredAt:number;acknowledgedAt:number|null;resolvedAt:number|null;
  source:{kind:'sync'|'release';sourceId:string;mailboxId?:string};global:boolean;
}
export interface CloudflareSuppressionAlertTimeline {
  id:string;action:'failed'|'resolved';outcome:CloudflareSuppressionAlertOutcome;version:number;errorCode:string|null;occurredAt:number;
  source:{kind:'sync'|'release';sourceId:string;mailboxId?:string};
}
export interface CloudflareSuppressionAlertList {
  configured:boolean;alerts:CloudflareSuppressionAlert[];nextCursor:string|null;
  summary:{open:number;acknowledged:number;resolved:number};
}
export interface CloudflareSuppressionAlertDetail {alert:CloudflareSuppressionAlert;timeline:CloudflareSuppressionAlertTimeline[];timelineTruncated:boolean}
