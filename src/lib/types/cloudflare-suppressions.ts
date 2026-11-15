export type CloudflareSuppressionReason='manual'|'complaint'|'hard_bounce'|'soft_bounce'|'policy';
export type CloudflareSuppressionScope={type:'account'}|{type:'sending_domain';value:string};
export type CloudflareSuppressionRemoteStatus='deleted'|'unknown'|'already_absent'|'failed'|'in_progress';
export type CloudflareSuppressionLocalStatus='released'|'changed'|'not_requested'|'pending';
export interface CloudflareSuppressionOperationResult {
  operationId:string;remoteStatus:CloudflareSuppressionRemoteStatus;localStatus:CloudflareSuppressionLocalStatus;errorCode?:string;
}
export interface CloudflareSuppression {
  id:string;address:string;reason:CloudflareSuppressionReason;scope:CloudflareSuppressionScope;readOnly:boolean;status:'active'|'absent';
  version:string;expiresAt:number|null;providerCreatedAt:number;seenAt:number;
  localSuppression:{id:string;version:number;status:'active'|'released';reason:'hard_bounce'|'complaint'}|null;
}
export interface CloudflareSuppressionList {
  configured:boolean;suppressions:CloudflareSuppression[];nextCursor:string|null;
  sync:{lastSuccessAt:number|null;lastAttemptAt:number|null;lastErrorCode:string|null}|null;
}
export interface CloudflareSuppressionHistoryEvent {
  id:string;action:string;state:string;remoteStatus:string|null;localStatus:string|null;errorCode:string|null;count:number|null;occurredAt:number;
}
interface HistoryBase {id:string;kind:'sync'|'release';state:string;startedAt:number;completedAt:number|null;errorCode:string|null;retryOf:string|null;canRetry:boolean;canReconcile:boolean}
export interface CloudflareSuppressionSyncHistory extends HistoryBase {kind:'sync';source:'owner'|'scheduled';count:number|null}
export interface CloudflareSuppressionReleaseHistory extends HistoryBase {
  kind:'release';remoteId:string;address:string;scope:CloudflareSuppressionScope;version:string;
  remoteStatus:CloudflareSuppressionRemoteStatus;localStatus:CloudflareSuppressionLocalStatus;
  current:{version:string;readOnly:boolean;localSuppression:CloudflareSuppression['localSuppression']}|null;
}
export type CloudflareSuppressionHistoryItem=CloudflareSuppressionSyncHistory|CloudflareSuppressionReleaseHistory;
export interface CloudflareSuppressionHistoryList {configured:boolean;history:CloudflareSuppressionHistoryItem[];nextCursor:string|null}
export interface CloudflareSuppressionHistoryDetail {item:CloudflareSuppressionHistoryItem;timeline:CloudflareSuppressionHistoryEvent[];timelineTruncated:boolean}
