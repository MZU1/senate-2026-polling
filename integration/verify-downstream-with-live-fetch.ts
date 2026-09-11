// ============================================================================
// VERIFICATION ONLY. Not part of the deployed system — not called by scheduler-daemon.ts,
// not called by api/server.ts, not referenced by anything that ships.
//
// Purpose: the real production path (ingestion/run-pass.ts, using the real emersonAdapter)
// just proved this sandbox's own network egress blocks emersoncollegepolling.com (403
// host_not_allowed — see the run above / integration/README.md). That's a sandbox
// limitation, not a code problem — but it means nothing in THIS environment can show a
// real fetch succeeding end-to-end. This script proves the OTHER 90% of the pipeline
// really works — real validation, real dedup, a real write to the real persistent Postgres
// database, a real weighted-average computation, served by the real API — using content
// that WAS genuinely fetched live from emersoncollegepolling.com (via a tool with different
// network access than this sandbox, 2026-08-26 — same files used in test/fixtures/, saved
// separately in integration/live-fetches/ — see prior turn). No text here is invented.
//
// The only thing substituted is the literal network call — everything from parseEmersonPost
// onward is the exact same unmodified code path emersonAdapter itself uses.
// ============================================================================
import fs from "fs";
import path from "path";
import { parseEmersonPost } from "../adapters/emerson";
import { ingestOne } from "../ingestion/pipeline";
import { PostgresPollStore } from "../db/postgres-store";
import { getPool, closePool } from "../db/connection";
import type { PollAdapter } from "../adapters/base";

const LIVE_DIR = path.join(__dirname, "live-fetches");
const LIVE_PAGES: Record<string, { file: string; url: string }> = {
  IA: { file: "emerson-IA-2026-08-26.txt", url: "https://emersoncollegepolling.com/iowa-2026-poll/" },
  TX: { file: "emerson-TX-2026-08-26.txt", url: "https://emersoncollegepolling.com/texas-2026-poll-paxton-and-talarico/" },
};

const verificationOnlyAdapter: PollAdapter = {
  pollsterId: "emerson",
  async fetchLatestPolls(race) {
    const page = race.geographicId ? LIVE_PAGES[race.geographicId] : undefined;
    if (!page) return [];
    const text = fs.readFileSync(path.join(LIVE_DIR, page.file), "utf8");
    return [parseEmersonPost(text, page.url, { raceId: race.raceId, geographicId: race.geographicId })];
  },
};

async function main() {
  const pool = getPool();
  const store = new PostgresPollStore(pool);

  const { rows: raceRows } = await pool.query(`SELECT race_id, geographic_id FROM races WHERE geographic_id IN ('IA','TX')`);
  const raceIdSet = new Set(raceRows.map((r: any) => `${r.race_id}::${r.geographic_id}`));
  const raceExists = (raceId: string, geographicId: string | null) => raceIdSet.has(`${raceId}::${geographicId ?? ""}`);

  for (const geographicId of Object.keys(LIVE_PAGES)) {
    const result = await ingestOne(verificationOnlyAdapter, { raceId: "senate_2026", geographicId }, store, raceExists);
    console.log(`${geographicId}:`, JSON.stringify(result));
  }

  const { rows: pollRows } = await pool.query(`SELECT poll_id, pollster_id, geographic_id, field_end, sample_size, margin_of_error, source_url FROM polls WHERE geographic_id IN ('IA','TX')`);
  console.log("\nReal rows now in the persistent database:");
  console.table(pollRows);

  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
