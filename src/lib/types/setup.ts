/** Owner-only diagnostics and attestations; never include cloud administration credentials here. */
export interface SetupAttestations {
  mailDomain:boolean;
  access:boolean;
  emailRouting:boolean;
  emailSending:boolean;
}
export interface SetupDTO {
  instance:{id:string|null;displayName:string;state:'pending'|'ready'|'maintenance';updatedAt:number|null};
  config:{mailDomain:string;consoleOrigin:string;apiOrigin:string;ownerEmail:string;accessTeamDomain:string;accessAud:string;sendingEnabled:boolean};
  resources:{d1:'migrated'|'migration_required'|'unavailable';r2:'connected'|'unavailable';schemaVersion:string|null;missingTables:string[];missingIndexes:string[];expectedMigrations:string[]};
  attestations:SetupAttestations;
  evidence:{activeMailboxCount:number;inboundCount:number;acceptedSendCount:number};
  configValid:boolean;
  configFingerprint:string;
  canComplete:boolean;
  configChanged:boolean;
}
export interface SetupProbeResult {success:boolean;code:'verified'|'probe_failed'|'cleanup_failed'}
