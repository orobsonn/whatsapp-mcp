-- Owner-admitted provenance; evidence never grants authority to its author.
CREATE TABLE IF NOT EXISTS assistant_fup_provenance (
 installation_id TEXT NOT NULL,generation TEXT NOT NULL,fup_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),
 command_operation_id TEXT NOT NULL,body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(body_json)<=16384),
 PRIMARY KEY(installation_id,generation,fup_id,version),
 FOREIGN KEY(installation_id,generation,fup_id,version) REFERENCES assistant_follow_ups(installation_id,generation,id,version),
 FOREIGN KEY(installation_id,generation,command_operation_id) REFERENCES assistant_owner_commands(installation_id,generation,operation_id)
);
CREATE INDEX IF NOT EXISTS assistant_fup_command_provenance ON assistant_owner_commands(installation_id,generation,json_extract(result_json,'$.id')) WHERE json_extract(result_json,'$.fupProvenance')=1;
