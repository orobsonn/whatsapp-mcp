-- The cross-provider paid-attempt fence uses the exact immutable parent, not
-- an installation-wide receipt scan for each image.
CREATE INDEX IF NOT EXISTS assistant_media_receipts_parent ON assistant_media_receipts(
  installation_id,generation,source_id,source_revision,source_version,source_hash,state
);
