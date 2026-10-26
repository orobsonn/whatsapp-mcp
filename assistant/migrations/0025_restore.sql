-- Canonical restore is inactive until a private external generation seal is configured.
-- Financial #37 keeps changing; revision CAS detects movement without freezing it.
DROP VIEW IF EXISTS assistant_conversation_modes;
CREATE TABLE IF NOT EXISTS assistant_retention_installation_gate (
 installation_id TEXT PRIMARY KEY,generation TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('idle','quiescing')),target_generation TEXT,
 mutation_revision INTEGER NOT NULL DEFAULT 0 CHECK(mutation_revision>=0),financial_revision INTEGER NOT NULL DEFAULT 0 CHECK(financial_revision>=0),started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_retention_snapshot_sessions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('preparing','exporting','checking_finance','sealing','sealed','invalid','cancelled')),schema_hash TEXT NOT NULL,tables_json TEXT NOT NULL,expected_counts_json TEXT NOT NULL,
 mutation_revision INTEGER NOT NULL,financial_revision INTEGER NOT NULL,financial_hash TEXT NOT NULL,authority_revision INTEGER NOT NULL,
 page_index INTEGER NOT NULL DEFAULT 0,next_cursor TEXT,page_chain TEXT NOT NULL,row_chain TEXT NOT NULL,counts_json TEXT NOT NULL DEFAULT '{}',row_count INTEGER NOT NULL DEFAULT 0,
 started_at INTEGER NOT NULL,manifest_json TEXT,seal TEXT,frontier_json TEXT NOT NULL DEFAULT '[]',financial_cursor TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(installation_id,generation,operation_id)
);
CREATE TABLE IF NOT EXISTS assistant_retention_snapshot_pages (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_id TEXT NOT NULL,page_index INTEGER NOT NULL,input_cursor TEXT,output_cursor TEXT,
 page_hash TEXT NOT NULL,chain TEXT NOT NULL,row_chain TEXT NOT NULL,counts_json TEXT NOT NULL,row_count INTEGER NOT NULL,frontier_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(installation_id,generation,operation_id,page_index)
);
CREATE TABLE IF NOT EXISTS assistant_retention_restore_sessions (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_id TEXT NOT NULL,source_generation TEXT NOT NULL,snapshot_seal TEXT NOT NULL,ticket_hash TEXT NOT NULL,token TEXT NOT NULL,request_hash TEXT NOT NULL,manifest_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('preparing','importing','finalizing','paused','inactive_complete','budget_blocked','blocked','uncertain')),expected_rows INTEGER NOT NULL,committed_rows INTEGER NOT NULL DEFAULT 0,report_json TEXT,created_at INTEGER NOT NULL,
 progress_json TEXT NOT NULL DEFAULT '{}',released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)),catchup_cursor INTEGER NOT NULL DEFAULT 0 CHECK(catchup_cursor>=0),activation_json TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(installation_id,generation,operation_id)
);
CREATE TABLE IF NOT EXISTS assistant_retention_restore_rows (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,operation_id TEXT NOT NULL,leaf_index INTEGER NOT NULL,table_name TEXT NOT NULL,source_row INTEGER NOT NULL,source_hash TEXT NOT NULL,source_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('imported','skipped_retired','financial_live_verified','financial_missing','historical_work')),
 PRIMARY KEY(installation_id,generation,operation_id,leaf_index),UNIQUE(installation_id,generation,operation_id,table_name,source_row)
);
CREATE TABLE IF NOT EXISTS assistant_retention_restore_grants (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,token TEXT NOT NULL,gate_token TEXT NOT NULL,table_name TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('insert','update','delete')),
 PRIMARY KEY(installation_id,generation,token,table_name,action)
);
CREATE TABLE IF NOT EXISTS assistant_retention_restored_work (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mission','follow_up')),id TEXT NOT NULL,version INTEGER NOT NULL,source_id TEXT NOT NULL,
 snapshot_seal TEXT NOT NULL,source_generation TEXT NOT NULL,original_command_id TEXT,body_json TEXT NOT NULL CHECK(json_valid(body_json)),
 PRIMARY KEY(installation_id,generation,kind,id,version)
);
CREATE TABLE IF NOT EXISTS assistant_retention_generation_seals (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,snapshot_seal TEXT NOT NULL,ticket_hash TEXT NOT NULL,financial_hash TEXT,
 state TEXT NOT NULL CHECK(state IN ('inactive_complete','budget_blocked','blocked')),seal TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation)
);
-- Releasing the canonical freeze never releases this hold. Reads, metadata
-- catch-up and explicit owner reproof remain possible; execution stays paused.
CREATE TABLE IF NOT EXISTS assistant_retention_runtime_hold (
 installation_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,target_generation TEXT NOT NULL,active INTEGER NOT NULL CHECK(active=1),created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_retention_active_generation (
 installation_id TEXT PRIMARY KEY,generation TEXT NOT NULL,snapshot_seal TEXT NOT NULL,ticket_hash TEXT NOT NULL,command_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE TRIGGER IF NOT EXISTS retention_generation_budget BEFORE INSERT ON assistant_budget_reservations
 WHEN EXISTS(SELECT 1 FROM assistant_retention_active_generation WHERE installation_id=NEW.installation_id AND generation<>NEW.generation)
 BEGIN SELECT RAISE(ABORT,'restore_generation_inactive'); END;
CREATE TRIGGER IF NOT EXISTS retention_generation_jobs BEFORE UPDATE OF state ON assistant_jobs
 WHEN NEW.state='processing' AND EXISTS(SELECT 1 FROM assistant_retention_active_generation WHERE installation_id=NEW.installation_id AND generation<>NEW.generation)
 BEGIN SELECT RAISE(ABORT,'restore_generation_inactive'); END;
CREATE TRIGGER IF NOT EXISTS retention_generation_calls BEFORE UPDATE OF state ON assistant_episode_calls
 WHEN NEW.state='attempting' AND EXISTS(SELECT 1 FROM assistant_retention_active_generation WHERE installation_id=NEW.installation_id AND generation<>NEW.generation)
 BEGIN SELECT RAISE(ABORT,'restore_generation_inactive'); END;
CREATE TRIGGER IF NOT EXISTS retention_hold_budget BEFORE INSERT ON assistant_budget_reservations
 WHEN EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=NEW.installation_id AND active=1)
 BEGIN SELECT RAISE(ABORT,'restore_runtime_paused'); END;
CREATE TRIGGER IF NOT EXISTS retention_hold_jobs BEFORE UPDATE OF state ON assistant_jobs
 WHEN NEW.state='processing' AND EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=NEW.installation_id AND active=1)
 BEGIN SELECT RAISE(ABORT,'restore_runtime_paused'); END;
CREATE TRIGGER IF NOT EXISTS retention_hold_episodes BEFORE UPDATE OF state ON assistant_episodes
 WHEN NEW.state IN ('dispatching','accepted','running') AND EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=NEW.installation_id AND active=1)
 BEGIN SELECT RAISE(ABORT,'restore_runtime_paused'); END;
CREATE TRIGGER IF NOT EXISTS retention_hold_model_calls BEFORE UPDATE OF state ON assistant_episode_calls
 WHEN NEW.state='attempting' AND EXISTS(SELECT 1 FROM assistant_retention_runtime_hold WHERE installation_id=NEW.installation_id AND active=1)
 BEGIN SELECT RAISE(ABORT,'restore_runtime_paused'); END;
CREATE TABLE IF NOT EXISTS assistant_retention_quarantines (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('origin_source','provider_identity','mandate','policy')),record_key TEXT NOT NULL,
 source_id TEXT,provider TEXT,address TEXT,mandate_id TEXT,conversation_id TEXT,version INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),reason TEXT NOT NULL,snapshot_seal TEXT NOT NULL,
 PRIMARY KEY(installation_id,generation,kind,record_key,version)
);
CREATE INDEX IF NOT EXISTS retention_quarantine_source ON assistant_retention_quarantines(installation_id,generation,kind,source_id,version,active);
CREATE INDEX IF NOT EXISTS retention_quarantine_identity ON assistant_retention_quarantines(installation_id,generation,kind,provider,address,active);
CREATE INDEX IF NOT EXISTS retention_quarantine_mandate ON assistant_retention_quarantines(installation_id,generation,kind,mandate_id,version,active);
CREATE INDEX IF NOT EXISTS retention_quarantine_policy ON assistant_retention_quarantines(installation_id,generation,kind,conversation_id,version,active);
-- All policy consumers, including Conversations and scheduler capture modes,
-- see restored authorization as dormant until a fresh owner revision exists.
CREATE VIEW IF NOT EXISTS assistant_conversation_modes AS
 SELECT installation_id,generation,conversation_id,kind,revision,
 CASE WHEN EXISTS(SELECT 1 FROM assistant_retention_quarantines q WHERE q.installation_id=p.installation_id AND q.generation=p.generation AND q.kind='policy' AND q.conversation_id=p.conversation_id AND q.version=p.revision AND q.active=1) THEN 'ignore'
 WHEN excluded=1 THEN 'ignore' WHEN kind='private' THEN 'attend' ELSE group_mode END AS effective_mode
 FROM assistant_conversation_policies p;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_sources_insert BEFORE INSERT ON assistant_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_sources' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_sources_update BEFORE UPDATE ON assistant_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_sources' AND r.action='update') AND NOT(OLD.status='active' AND NEW.status='withdrawn' AND NEW.revision=OLD.revision+1 AND (NEW.current_version IS OLD.current_version OR NEW.current_version IS NULL) AND NEW.installation_id IS OLD.installation_id AND NEW.generation IS OLD.generation AND NEW.id IS OLD.id AND NEW.origin IS OLD.origin AND NEW.origin_key IS OLD.origin_key AND NEW.title IS OLD.title AND NEW.conversation_id IS OLD.conversation_id AND NEW.project_id IS OLD.project_id AND NEW.audience IS OLD.audience)
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_sources_delete BEFORE DELETE ON assistant_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_sources' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_versions_insert BEFORE INSERT ON assistant_source_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_source_versions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_versions_update BEFORE UPDATE ON assistant_source_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_source_versions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_versions_delete BEFORE DELETE ON assistant_source_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_source_versions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_admissions_insert BEFORE INSERT ON assistant_source_admissions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_source_admissions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_admissions_update BEFORE UPDATE ON assistant_source_admissions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_source_admissions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_admissions_delete BEFORE DELETE ON assistant_source_admissions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_source_admissions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_origins_insert BEFORE INSERT ON assistant_source_origins
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_source_origins' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_origins_update BEFORE UPDATE ON assistant_source_origins
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_source_origins' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_source_origins_delete BEFORE DELETE ON assistant_source_origins
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_source_origins' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_origin_versions_insert BEFORE INSERT ON assistant_origin_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_origin_versions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_origin_versions_update BEFORE UPDATE ON assistant_origin_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_origin_versions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_origin_versions_delete BEFORE DELETE ON assistant_origin_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_origin_versions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_origin_conversations_insert BEFORE INSERT ON assistant_origin_conversations
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_origin_conversations' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_origin_conversations_update BEFORE UPDATE ON assistant_origin_conversations
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_origin_conversations' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_origin_conversations_delete BEFORE DELETE ON assistant_origin_conversations
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_origin_conversations' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_people_insert BEFORE INSERT ON assistant_people
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_people' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_people_update BEFORE UPDATE ON assistant_people
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_people' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_people_delete BEFORE DELETE ON assistant_people
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_people' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_provider_identities_insert BEFORE INSERT ON assistant_provider_identities
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_provider_identities' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_provider_identities_update BEFORE UPDATE ON assistant_provider_identities
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_provider_identities' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_provider_identities_delete BEFORE DELETE ON assistant_provider_identities
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_provider_identities' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_projects_insert BEFORE INSERT ON assistant_projects
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_projects' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_projects_update BEFORE UPDATE ON assistant_projects
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_projects' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_projects_delete BEFORE DELETE ON assistant_projects
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_projects' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_project_memberships_insert BEFORE INSERT ON assistant_project_memberships
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_project_memberships' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_project_memberships_update BEFORE UPDATE ON assistant_project_memberships
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_project_memberships' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_project_memberships_delete BEFORE DELETE ON assistant_project_memberships
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_project_memberships' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_conversation_policies_insert BEFORE INSERT ON assistant_conversation_policies
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_conversation_policies' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_conversation_policies_update BEFORE UPDATE ON assistant_conversation_policies
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_conversation_policies' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_conversation_policies_delete BEFORE DELETE ON assistant_conversation_policies
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_conversation_policies' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_policy_versions_insert BEFORE INSERT ON assistant_policy_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_policy_versions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_policy_versions_update BEFORE UPDATE ON assistant_policy_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_policy_versions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_policy_versions_delete BEFORE DELETE ON assistant_policy_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_policy_versions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandates_insert BEFORE INSERT ON assistant_mandates
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mandates' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandates_update BEFORE UPDATE ON assistant_mandates
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mandates' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandates_delete BEFORE DELETE ON assistant_mandates
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_mandates' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandate_actions_insert BEFORE INSERT ON assistant_mandate_actions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mandate_actions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandate_actions_update BEFORE UPDATE ON assistant_mandate_actions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mandate_actions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandate_actions_delete BEFORE DELETE ON assistant_mandate_actions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_mandate_actions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandate_sources_insert BEFORE INSERT ON assistant_mandate_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mandate_sources' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandate_sources_update BEFORE UPDATE ON assistant_mandate_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mandate_sources' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mandate_sources_delete BEFORE DELETE ON assistant_mandate_sources
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_mandate_sources' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_missions_insert BEFORE INSERT ON assistant_missions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_missions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_missions_update BEFORE UPDATE ON assistant_missions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_missions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_missions_delete BEFORE DELETE ON assistant_missions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_missions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mission_versions_insert BEFORE INSERT ON assistant_mission_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mission_versions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mission_versions_update BEFORE UPDATE ON assistant_mission_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_mission_versions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_mission_versions_delete BEFORE DELETE ON assistant_mission_versions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_mission_versions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_follow_ups_insert BEFORE INSERT ON assistant_follow_ups
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_follow_ups' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_follow_ups_update BEFORE UPDATE ON assistant_follow_ups
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_follow_ups' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_follow_ups_delete BEFORE DELETE ON assistant_follow_ups
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_follow_ups' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_fup_provenance_insert BEFORE INSERT ON assistant_fup_provenance
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_fup_provenance' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_fup_provenance_update BEFORE UPDATE ON assistant_fup_provenance
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_fup_provenance' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_fup_provenance_delete BEFORE DELETE ON assistant_fup_provenance
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_fup_provenance' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_financial_assistant_budget_accounts_insert AFTER INSERT ON assistant_budget_accounts
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=NEW.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_financial_assistant_budget_accounts_update AFTER UPDATE ON assistant_budget_accounts
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=NEW.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_financial_assistant_budget_accounts_delete AFTER DELETE ON assistant_budget_accounts
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=OLD.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_financial_assistant_budget_reservations_insert AFTER INSERT ON assistant_budget_reservations
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=NEW.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_financial_assistant_budget_reservations_update AFTER UPDATE ON assistant_budget_reservations
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=NEW.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_financial_assistant_budget_reservations_delete AFTER DELETE ON assistant_budget_reservations
 BEGIN UPDATE assistant_retention_installation_gate SET financial_revision=financial_revision+1 WHERE installation_id=OLD.installation_id; END;
CREATE TRIGGER IF NOT EXISTS retention_mutation_assistant_sources_update AFTER UPDATE ON assistant_sources
 BEGIN UPDATE assistant_retention_installation_gate SET mutation_revision=mutation_revision+1 WHERE installation_id=NEW.installation_id AND state='quiescing'; END;
CREATE TRIGGER IF NOT EXISTS retention_mutation_assistant_retention_barriers_insert AFTER INSERT ON assistant_retention_barriers
 BEGIN UPDATE assistant_retention_installation_gate SET mutation_revision=mutation_revision+1 WHERE installation_id=NEW.installation_id AND state='quiescing'; END;
CREATE TRIGGER IF NOT EXISTS retention_mutation_assistant_retention_barriers_update AFTER UPDATE ON assistant_retention_barriers
 BEGIN UPDATE assistant_retention_installation_gate SET mutation_revision=mutation_revision+1 WHERE installation_id=NEW.installation_id AND state='quiescing'; END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_retention_restored_work_insert BEFORE INSERT ON assistant_retention_restored_work
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_retention_restored_work' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_retention_restored_work_update BEFORE UPDATE ON assistant_retention_restored_work
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_retention_restored_work' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_retention_restored_work_delete BEFORE DELETE ON assistant_retention_restored_work
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_retention_restored_work' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;

CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_project_revisions_insert BEFORE INSERT ON assistant_project_revisions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_project_revisions' AND r.action='insert')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_project_revisions_update BEFORE UPDATE ON assistant_project_revisions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=NEW.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=NEW.installation_id AND r.generation=NEW.generation AND r.table_name='assistant_project_revisions' AND r.action='update')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
CREATE TRIGGER IF NOT EXISTS retention_freeze_assistant_project_revisions_delete BEFORE DELETE ON assistant_project_revisions
 WHEN EXISTS(SELECT 1 FROM assistant_retention_installation_gate g WHERE g.installation_id=OLD.installation_id AND g.state='quiescing')
 AND NOT EXISTS(SELECT 1 FROM assistant_retention_restore_grants r JOIN assistant_retention_installation_gate g ON g.installation_id=r.installation_id AND g.token=r.gate_token AND g.state='quiescing'
 WHERE r.installation_id=OLD.installation_id AND r.generation=OLD.generation AND r.table_name='assistant_project_revisions' AND r.action='delete')
 BEGIN SELECT RAISE(ABORT,'canonical_writers_quiesced'); END;
