
-- Identity and policy storage only: controllers validate evidence, current
-- versions, expiry and access. No table/view grants a runtime send capability.
CREATE TABLE IF NOT EXISTS assistant_people (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, display_name TEXT,
  PRIMARY KEY(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_provider_identities (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(length(provider)>0),
  address TEXT NOT NULL CHECK(length(address)>0),
  person_id TEXT NOT NULL,
  proof_source_id TEXT NOT NULL,
  proof_source_revision INTEGER NOT NULL CHECK(proof_source_revision>0),
  proof_kind TEXT NOT NULL CHECK(proof_kind IN ('owner_confirmed','provider_verified')),
  verified_at INTEGER NOT NULL CHECK(verified_at>=0),
  PRIMARY KEY(installation_id,generation,provider,address),
  FOREIGN KEY(installation_id,generation,person_id)
    REFERENCES assistant_people(installation_id,generation,id),
  FOREIGN KEY(installation_id,generation,proof_source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);
CREATE INDEX IF NOT EXISTS assistant_identities_person ON assistant_provider_identities(installation_id,generation,person_id);

CREATE TABLE IF NOT EXISTS assistant_projects (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_project_memberships (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, project_id TEXT NOT NULL, person_id TEXT NOT NULL,
  role TEXT NOT NULL, valid_from INTEGER NOT NULL CHECK(valid_from>=0),
  valid_until INTEGER CHECK(valid_until IS NULL OR valid_until>valid_from),
  PRIMARY KEY(installation_id,generation,id),
  FOREIGN KEY(installation_id,generation,project_id)
    REFERENCES assistant_projects(installation_id,generation,id),
  FOREIGN KEY(installation_id,generation,person_id)
    REFERENCES assistant_people(installation_id,generation,id)
);
CREATE INDEX IF NOT EXISTS assistant_memberships_project ON assistant_project_memberships(installation_id,generation,project_id,valid_from,valid_until);
CREATE INDEX IF NOT EXISTS assistant_memberships_person ON assistant_project_memberships(installation_id,generation,person_id,valid_from,valid_until);

-- Private attendance is the preference; exclusions are explicit, never inferred
-- from a name, relationship or category. Groups start ignored.
CREATE TABLE IF NOT EXISTS assistant_conversation_policies (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  conversation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('private','group')),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
  group_mode TEXT NOT NULL DEFAULT 'ignore' CHECK(group_mode IN ('ignore','observe','respond')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  PRIMARY KEY(installation_id,generation,conversation_id),
  CHECK(kind='group' OR group_mode='ignore')
);
CREATE VIEW IF NOT EXISTS assistant_conversation_modes AS
  SELECT installation_id,generation,conversation_id,kind,revision,
    CASE WHEN excluded=1 THEN 'ignore' WHEN kind='private' THEN 'attend' ELSE group_mode END AS effective_mode
  FROM assistant_conversation_policies;

-- Each mandate version names a conversation and expires. Drafts and empty
-- action/source sets are the default. Controllers select the current version;
-- an old active version must not override a newer revoked version.
CREATE TABLE IF NOT EXISTS assistant_mandates (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  conversation_id TEXT NOT NULL, project_id TEXT,
  purpose TEXT NOT NULL CHECK(length(purpose)>0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','revoked')),
  issued_at INTEGER NOT NULL CHECK(issued_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  PRIMARY KEY(installation_id,generation,id,version),
  FOREIGN KEY(installation_id,generation,conversation_id)
    REFERENCES assistant_conversation_policies(installation_id,generation,conversation_id),
  FOREIGN KEY(installation_id,generation,project_id)
    REFERENCES assistant_projects(installation_id,generation,id)
);
CREATE INDEX IF NOT EXISTS assistant_mandates_conversation ON assistant_mandates(installation_id,generation,conversation_id,status,expires_at);
CREATE TABLE IF NOT EXISTS assistant_mandate_actions (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  mandate_id TEXT NOT NULL, mandate_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reply_text','reply_audio','ask_clarification','future_contact','read_github','read_calendar','propose_calendar_change')),
  PRIMARY KEY(installation_id,generation,mandate_id,mandate_version,action),
  FOREIGN KEY(installation_id,generation,mandate_id,mandate_version)
    REFERENCES assistant_mandates(installation_id,generation,id,version)
);
CREATE TABLE IF NOT EXISTS assistant_mandate_sources (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL,
  mandate_id TEXT NOT NULL, mandate_version INTEGER NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY(installation_id,generation,mandate_id,mandate_version,source_id),
  FOREIGN KEY(installation_id,generation,mandate_id,mandate_version)
    REFERENCES assistant_mandates(installation_id,generation,id,version),
  FOREIGN KEY(installation_id,generation,source_id)
    REFERENCES assistant_sources(installation_id,generation,id)
);
