/** Bindings are injected into core services; no SvelteKit or Cloudflare module imports here. */
export interface RuntimeEnv {
  DB: D1Database;
  MAIL_BLOBS: R2Bucket;
  EMAIL?: SendEmail;
  ASSETS: Fetcher;
  MAIL_DOMAIN: string;
  CONSOLE_ORIGIN: string;
  API_ORIGIN: string;
  OWNER_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Comma-separated trusted CIMD hostnames. Empty disables remote client metadata fetching. */
  OAUTH_CIMD_ALLOWED_HOSTS?: string;
  /** JSON AES-GCM wrapping keyring, stored as a Worker secret. */
  WEBHOOK_KEYRING?:string;
  /** Dedicated Cloudflare Email Sending Event Subscription consumer allowlist. All are required. */
  EMAIL_EVENT_QUEUE?:string;
  EMAIL_EVENT_ACCOUNT_ID?:string;
  EMAIL_EVENT_ZONE_ID?:string;
  EMAIL_EVENT_SUBSCRIPTION_ID?:string;
  EMAIL_EVENT_DOMAIN?:string;
  /** Optional operator-controlled HTTP bridge HMAC secret, separate from Cloudflare native Queue trust. */
  EMAIL_EVENT_BRIDGE_SECRET?:string;
  /** Optional account-scoped Email Sending:Edit API token. Worker secret only, never D1/browser/ordinary vars. */
  EMAIL_SUPPRESSIONS_API_TOKEN?:string;
  EMAIL_SUPPRESSIONS_ACCOUNT_ID?:string;
  /** Explicit exact sending domain whose provider records this instance synchronizes. */
  EMAIL_SUPPRESSIONS_DOMAIN?:string;
}

export type Actor =
  | { kind: 'owner'; email: string }
  | { kind: 'token'; mailboxId: string; tokenId: string; canRead: boolean;
      canReadAttachments?:boolean; canDraft?: boolean; canSend?: boolean; requiresApproval?: boolean;
      oauthGrantId?:string; oauthAccessTokenId?:string; oauthClientId?:string };

export class ServiceError extends Error {
  constructor(public code: string, public status = 500) { super(code); }
}

export const capabilities = {
  inboundEmail: true,
  textIndexing: true,
  attachmentExtraction: true,
  outboundEmail: true,
  mcp: true
} as const;
