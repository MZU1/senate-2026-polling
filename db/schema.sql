-- ============================================================================
-- Schema for the normalized poll store. Plain, portable SQL — no extensions, no superuser
-- privileges required, so it runs unmodified on Neon, Supabase, RDS, or a local instance.
-- Run once against a fresh database: `psql "$DATABASE_URL" -f db/schema.sql`, then
-- `npx tsx db/seed.ts <path-to-map-tsx>`. See DEPLOYMENT.md for the exact sequence.
-- Actually executed against a real local Postgres 16 instance this session — not just
-- reviewed for syntax; see DEPLOYMENT.md "What was verified" for specifics.
-- ============================================================================

CREATE TABLE pollsters (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  approved            BOOLEAN NOT NULL DEFAULT false,
  official_domains    TEXT[] NOT NULL,
  ingestion_method    TEXT NOT NULL CHECK (ingestion_method IN ('official_api','official_feed','source_page_adapter','manual')),
  adapter_id          TEXT,
  quality_notes       TEXT,
  historical_lean_d   NUMERIC,
  source_url          TEXT NOT NULL
);

CREATE TABLE races (
  race_id             TEXT NOT NULL,       -- e.g. 'senate_2026'
  geographic_id       TEXT,                -- e.g. 'NC', or 'NC-13' for House, NULL for president
  chamber             TEXT NOT NULL CHECK (chamber IN ('senate','house','governor','president')),
  election_day        DATE NOT NULL,
  PRIMARY KEY (race_id, geographic_id)
);

CREATE TABLE polls (
  poll_id             TEXT PRIMARY KEY,              -- deterministic hash, see validation/dedupe.ts
  pollster_id         TEXT NOT NULL REFERENCES pollsters(id),
  sponsor             TEXT,
  source_url          TEXT NOT NULL,
  race_id             TEXT NOT NULL,
  geographic_id       TEXT,
  field_start         DATE,
  field_end           DATE,
  published_at        TIMESTAMPTZ,
  sample_size         INTEGER,
  population          TEXT NOT NULL DEFAULT 'unknown' CHECK (population IN ('LV','RV','A','V','unknown')),
  margin_of_error     NUMERIC,
  methodology_note    TEXT,
  undecided_share     NUMERIC,
  other_share         NUMERIC,
  raw_excerpt         TEXT,                          -- audit trail: what the adapter actually parsed
  ingestion_method    TEXT NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (race_id, geographic_id) REFERENCES races(race_id, geographic_id)
);
CREATE INDEX idx_polls_race ON polls (race_id, geographic_id);
CREATE INDEX idx_polls_pollster ON polls (pollster_id);
CREATE INDEX idx_polls_field_end ON polls (field_end);

CREATE TABLE poll_candidates (
  poll_id             TEXT NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,
  candidate_name      TEXT NOT NULL,
  party               TEXT NOT NULL CHECK (party IN ('D','R','I','O')),
  share               NUMERIC NOT NULL CHECK (share >= 0 AND share <= 100),
  PRIMARY KEY (poll_id, candidate_name)
);

-- Every rejected/failed ingestion attempt — "log ingestion failures instead of silently
-- creating incorrect data" (spec item 5), kept as real rows, not just console output.
CREATE TABLE ingestion_failures (
  id                  BIGSERIAL PRIMARY KEY,
  pollster_id         TEXT NOT NULL,
  source_url          TEXT,
  reason              TEXT NOT NULL,
  detail              TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per scheduled run, per pollster/race — lets the frontend (or an ops dashboard)
-- show "last checked" freshness honestly instead of a vague "live" badge.
CREATE TABLE ingestion_runs (
  id                  BIGSERIAL PRIMARY KEY,
  pollster_id         TEXT NOT NULL,
  race_id             TEXT NOT NULL,
  geographic_id       TEXT,
  run_at              TIMESTAMPTZ NOT NULL,
  fetched             INTEGER NOT NULL,
  accepted            INTEGER NOT NULL,
  duplicates          INTEGER NOT NULL,
  rejected            INTEGER NOT NULL
);
CREATE INDEX idx_runs_race ON ingestion_runs (race_id, geographic_id, run_at DESC);
