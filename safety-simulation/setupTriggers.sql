-- Run this once to add tamper-detection to the existing offchain.db
-- Usage: sqlite3 ~/fabric/safety-simulation/offchain.db < setupTriggers.sql

CREATE TABLE IF NOT EXISTS verification_alerts (
    alert_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id   TEXT NOT NULL,
    flagged_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    old_hash      TEXT,
    resolved      INTEGER NOT NULL DEFAULT 0,
    resolved_at   TEXT,
    verdict       TEXT
);

CREATE TRIGGER IF NOT EXISTS trg_flag_payload_tamper
AFTER UPDATE OF raw_payload ON raw_events
WHEN OLD.raw_payload != NEW.raw_payload
BEGIN
    INSERT INTO verification_alerts (incident_id, old_hash)
    VALUES (NEW.incident_id, OLD.payload_hash);
END;
