export type RecipientSuppressionReason='hard_bounce'|'complaint';
export type RecipientSuppressionStatus='active'|'released';
export interface RecipientSuppression {
  id:string;mailboxId:string;address:string;status:RecipientSuppressionStatus;reason:RecipientSuppressionReason;version:number;
  lastEventAt:number;lastEventId:string;createdAt:number;updatedAt:number;releasedAt:number|null;
}
export interface RecipientSuppressionCheck {address:string;suppressed:boolean;reason:RecipientSuppressionReason|'provider_suppression'|null}
