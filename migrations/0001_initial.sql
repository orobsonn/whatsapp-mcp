PRAGMA foreign_keys = ON;
CREATE TABLE chats (
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation TEXT NOT NULL,
 external_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('individual','group')),
 name TEXT NOT NULL, capture_enabled INTEGER NOT NULL DEFAULT 0, capture_since INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(epoch,generation,external_id)
);
CREATE TABLE participants (
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL, generation TEXT NOT NULL,
 external_id TEXT NOT NULL, name TEXT, UNIQUE(epoch,generation,external_id)
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), epoch TEXT NOT NULL, generation TEXT NOT NULL,
 external_id TEXT NOT NULL, author_id TEXT REFERENCES participants(id), from_me INTEGER NOT NULL,
 kind TEXT NOT NULL, text TEXT, timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, status_rank INTEGER NOT NULL DEFAULT 0, failure TEXT,
 deleted_at INTEGER, unavailable_reason TEXT,
 UNIQUE(epoch,generation,chat_id,external_id)
);
CREATE INDEX messages_query ON messages(chat_id,timestamp,id);
CREATE INDEX messages_external ON messages(epoch,generation,external_id);
CREATE TABLE message_versions (message_id TEXT NOT NULL REFERENCES messages(id),version INTEGER NOT NULL,text TEXT,kind TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(message_id,version));
CREATE TABLE pending_statuses (
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL,generation TEXT NOT NULL,external_id TEXT NOT NULL,
 chat_external_id TEXT NOT NULL DEFAULT '',status_rank INTEGER NOT NULL,failure TEXT,created_at INTEGER NOT NULL,
 UNIQUE(epoch,generation,chat_external_id,external_id)
);
CREATE TABLE directory_syncs (id TEXT PRIMARY KEY,epoch TEXT NOT NULL,generation TEXT NOT NULL,cursor TEXT,complete INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE media (
 id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),message_id TEXT REFERENCES messages(id),
 version INTEGER NOT NULL DEFAULT 1,message_version INTEGER NOT NULL DEFAULT 1,epoch TEXT NOT NULL,generation TEXT NOT NULL,
 kind TEXT NOT NULL,mime TEXT,size INTEGER,sha256 TEXT,object_key TEXT,state TEXT NOT NULL,
 source_url TEXT,filename TEXT,duration_seconds REAL,deleted_at INTEGER,created_at INTEGER NOT NULL,
 UNIQUE(message_id,message_version)
);
CREATE TABLE media_derivatives (
 id TEXT PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id),media_version INTEGER NOT NULL,
 epoch TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,object_key TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE TABLE media_jobs (
 id TEXT PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id),message_version INTEGER NOT NULL,
 epoch TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'download',status TEXT NOT NULL,
 lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,error TEXT,
 UNIQUE(media_id,kind,message_version)
);
CREATE TABLE actions (
 id TEXT PRIMARY KEY,epoch TEXT NOT NULL,generation TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id),
 envelope_json TEXT NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,
 approved_at INTEGER,attempted_at INTEGER,provider_message_id TEXT,provider_zaap_id TEXT,last_error TEXT,created_at INTEGER NOT NULL
);
CREATE INDEX actions_provider ON actions(epoch,generation,provider_message_id);
CREATE TABLE policies (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,epoch TEXT NOT NULL,updated_at INTEGER NOT NULL);
