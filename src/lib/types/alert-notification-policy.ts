export interface AlertNotificationPolicy {
  enabled:boolean;recoveryEnabled:boolean;repeatIntervalSeconds:number;
  quietEnabled:boolean;quietStartMinute:number;quietEndMinute:number;timeZone:string;
  version:number;updatedAt:number;
}
export type AlertNotificationPolicyInput=Omit<AlertNotificationPolicy,'version'|'updatedAt'>&{expectedVersion:number};
