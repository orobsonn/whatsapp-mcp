
-- Transport acknowledgement only; never an assistant application cursor.
CREATE TABLE IF NOT EXISTS assistant_bridge_cursors (
 epoch TEXT NOT NULL, generation TEXT NOT NULL,
 installation_id TEXT NOT NULL, target_generation TEXT NOT NULL,
 acknowledged_sequence INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_sequence>=0),
 PRIMARY KEY(epoch,generation,installation_id,target_generation)
);
