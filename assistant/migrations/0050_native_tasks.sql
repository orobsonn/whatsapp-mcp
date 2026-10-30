-- Explicit enrollment only. Existing missions/FUPs are not migrated or drained.
CREATE TABLE assistant_native_task_bindings (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('mission','follow_up')),resource_id TEXT NOT NULL,resource_version INTEGER NOT NULL,
 source_ref_json TEXT NOT NULL,authorization_ref_json TEXT NOT NULL,owner_fence_json TEXT NOT NULL,
 activation_key TEXT NOT NULL,activation_json TEXT NOT NULL,principal_id TEXT NOT NULL,thread_id TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,generation,id),UNIQUE(installation_id,generation,kind,resource_id,resource_version)
);
CREATE TABLE assistant_native_task_occurrences (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,binding_id TEXT NOT NULL,
 kind TEXT NOT NULL,resource_id TEXT NOT NULL,resource_version INTEGER NOT NULL,due_at INTEGER NOT NULL,
 conversation_id TEXT NOT NULL,identity_json TEXT NOT NULL,event_id TEXT NOT NULL,event_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','admitted','uncertain','notified','invalidated')),
 task_ref TEXT,receipt_json TEXT,created_at INTEGER NOT NULL,last_attempt_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(installation_id,generation,id),UNIQUE(installation_id,generation,kind,resource_id,resource_version,due_at)
);
-- Host hook observations, never model metadata or a mutable active-task pointer.
CREATE TABLE assistant_native_consumed_inputs (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,conversation_id TEXT NOT NULL,
 submission_id TEXT NOT NULL,task_ref TEXT NOT NULL,sequence INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,submission_id,task_ref),UNIQUE(conversation_id,submission_id,sequence)
);
CREATE TRIGGER assistant_native_task_binding_immutable BEFORE UPDATE ON assistant_native_task_bindings
 BEGIN SELECT RAISE(ABORT,'native_task_binding_immutable'); END;
CREATE TRIGGER assistant_native_task_occurrence_immutable BEFORE UPDATE ON assistant_native_task_occurrences
 WHEN NEW.installation_id<>OLD.installation_id OR NEW.generation<>OLD.generation OR NEW.id<>OLD.id OR NEW.binding_id<>OLD.binding_id
 OR NEW.kind<>OLD.kind OR NEW.resource_id<>OLD.resource_id OR NEW.resource_version<>OLD.resource_version OR NEW.due_at<>OLD.due_at
 OR NEW.conversation_id<>OLD.conversation_id OR NEW.identity_json<>OLD.identity_json OR NEW.event_id<>OLD.event_id OR NEW.event_hash<>OLD.event_hash
 BEGIN SELECT RAISE(ABORT,'native_task_occurrence_immutable'); END;
CREATE TRIGGER assistant_native_consumption_immutable BEFORE UPDATE ON assistant_native_consumed_inputs
 BEGIN SELECT RAISE(ABORT,'native_consumption_immutable'); END;
