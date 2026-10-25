-- All monetary values are integer microUSD. Uncertain calls retain their ceiling.
CREATE TABLE IF NOT EXISTS assistant_budget_accounts (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, period TEXT NOT NULL,
 cap_units INTEGER NOT NULL CHECK(typeof(cap_units)='integer' AND cap_units BETWEEN 0 AND 9007199254740991),
 blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
 PRIMARY KEY(installation_id,generation,period)
);
CREATE TABLE IF NOT EXISTS assistant_budget_reservations (
 installation_id TEXT NOT NULL, generation TEXT NOT NULL, operation_key TEXT NOT NULL,
 period TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 ceiling_units INTEGER NOT NULL CHECK(typeof(ceiling_units)='integer' AND ceiling_units BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','uncertain','settled')),
 actual_units INTEGER CHECK(actual_units IS NULL OR (typeof(actual_units)='integer' AND actual_units BETWEEN 0 AND 9007199254740991)),
 PRIMARY KEY(installation_id,generation,operation_key),
 CHECK((state IN ('reserved','uncertain') AND actual_units IS NULL) OR (state='settled' AND actual_units IS NOT NULL)),
 FOREIGN KEY(installation_id,generation,period) REFERENCES assistant_budget_accounts(installation_id,generation,period)
);
CREATE INDEX IF NOT EXISTS assistant_budget_period ON assistant_budget_reservations(installation_id,generation,period);
CREATE INDEX IF NOT EXISTS assistant_budget_blocked ON assistant_budget_accounts(installation_id,generation,blocked);
