-- Owner initialization attestations are bound to the deployed configuration, not a first-visitor identity.
ALTER TABLE instance_settings ADD COLUMN setup_checks_json TEXT NOT NULL DEFAULT '{}'
 CHECK(json_valid(setup_checks_json) AND json_type(setup_checks_json)='object');
ALTER TABLE instance_settings ADD COLUMN setup_config_sha256 TEXT
 CHECK(setup_config_sha256 IS NULL OR(length(setup_config_sha256)=64 AND setup_config_sha256 NOT GLOB '*[^0-9a-f]*'));
