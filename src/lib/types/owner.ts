/** Safe DTOs shared by the console and server. Never add token digests or secrets here. */
export interface MailboxSummary {
  id: string;
  name: string;
  address: string;
  status: 'active' | 'paused' | 'deleted';
  maxMessageBytes: number;
  dailyRecipientLimit: number;
  allowedRecipients: string[];
  createdAt: number;
  updatedAt: number;
  activeTokenCount: number;
}

export interface MailboxToken {
  id: string;
  mailboxId: string;
  name: string;
  scopes: string[];
  requiresApproval: boolean;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  state: 'active' | 'expired' | 'revoked';
}
