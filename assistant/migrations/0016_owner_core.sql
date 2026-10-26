-- Additive snapshots of control metadata, never copies of source bodies.
CREATE TABLE IF NOT EXISTS assistant_mission_versions (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  changed_at INTEGER NOT NULL CHECK(changed_at>=0), PRIMARY KEY(installation_id,generation,id,revision),
  FOREIGN KEY(installation_id,generation,id) REFERENCES assistant_missions(installation_id,generation,id)
);
CREATE TABLE IF NOT EXISTS assistant_policy_versions (
  installation_id TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  changed_at INTEGER NOT NULL CHECK(changed_at>=0), PRIMARY KEY(installation_id,generation,id,revision),
  FOREIGN KEY(installation_id,generation,id) REFERENCES assistant_conversation_policies(installation_id,generation,conversation_id)
);
INSERT INTO assistant_mission_versions SELECT installation_id,generation,id,revision,
  json_object('objective',objective,'sourceId',source_id,'sourceRevision',source_revision,'projectId',project_id,'stopCondition',stop_condition,'state',state,'nextEvaluationAt',next_evaluation_at),0
  FROM assistant_missions m WHERE NOT EXISTS(SELECT 1 FROM assistant_mission_versions h WHERE h.installation_id=m.installation_id AND h.generation=m.generation AND h.id=m.id AND h.revision=m.revision);
INSERT INTO assistant_policy_versions SELECT installation_id,generation,conversation_id,revision,
  json_object('conversationKind',kind,'excluded',excluded,'groupMode',group_mode),0
  FROM assistant_conversation_policies p WHERE NOT EXISTS(SELECT 1 FROM assistant_policy_versions h WHERE h.installation_id=p.installation_id AND h.generation=p.generation AND h.id=p.conversation_id AND h.revision=p.revision);
CREATE TRIGGER IF NOT EXISTS assistant_mission_history_no_update BEFORE UPDATE ON assistant_mission_versions BEGIN SELECT RAISE(ABORT,'immutable_mission_history'); END;
CREATE TRIGGER IF NOT EXISTS assistant_mission_history_no_replace BEFORE INSERT ON assistant_mission_versions WHEN EXISTS(SELECT 1 FROM assistant_mission_versions WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND id=NEW.id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'immutable_mission_history'); END;
CREATE TRIGGER IF NOT EXISTS assistant_policy_history_no_update BEFORE UPDATE ON assistant_policy_versions BEGIN SELECT RAISE(ABORT,'immutable_policy_history'); END;
CREATE TRIGGER IF NOT EXISTS assistant_policy_history_no_replace BEFORE INSERT ON assistant_policy_versions WHEN EXISTS(SELECT 1 FROM assistant_policy_versions WHERE installation_id=NEW.installation_id AND generation=NEW.generation AND id=NEW.id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'immutable_policy_history'); END;
