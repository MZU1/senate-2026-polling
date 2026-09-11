// ============================================================================
// NOT run by the deployed system (scheduler-daemon.ts and api/server.ts's POST /api/ingest
// call ingestion/run-pass.ts directly, never this file). This exists only so a local dev
// instance — or this sandbox, whose egress proxy blocks emersoncollegepolling.com the same
// way the earlier session's README documented — has some ingestion_runs/ingestion_failures
// history to actually exercise GET /api/ingestion-status and the map's Data Center against,
// via the real PostgresPollStore.logRun()/logFailure() methods (not raw INSERTs bypassing
// the application code those routes actually call).
//
// Run with: DATABASE_URL=postgresql://... npx tsx db/seed-ingestion-history.ts
// ============================================================================
import { getPool, closePool } from "./connection";
import { PostgresPollStore } from "./postgres-store";

async function main() {
  const pool = getPool();
  const store = new PostgresPollStore(pool);
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

  // A plausible recent history for Emerson across a few states: mostly clean successful runs,
  // one run that turned up nothing new (0 accepted), and two real failure rows -- one from the
  // sandbox's actual 403 (documented in README.md), one illustrating a validation rejection.
  const runs: Array<Parameters<PostgresPollStore["logRun"]>[0]> = [
    { pollsterId: "emerson", raceId: "senate_2026", geographicId: "IA", runAt: minutesAgo(6), fetched: 1, accepted: 1, duplicates: 0, rejected: 0 },
    { pollsterId: "emerson", raceId: "senate_2026", geographicId: "TX", runAt: minutesAgo(6), fetched: 1, accepted: 1, duplicates: 0, rejected: 0 },
    { pollsterId: "emerson", raceId: "senate_2026", geographicId: "NC", runAt: minutesAgo(6), fetched: 1, accepted: 0, duplicates: 1, rejected: 0 },
    { pollsterId: "emerson", raceId: "senate_2026", geographicId: "MI", runAt: minutesAgo(21), fetched: 0, accepted: 0, duplicates: 0, rejected: 0 },
    { pollsterId: "emerson", raceId: "senate_2026", geographicId: "GA", runAt: minutesAgo(21), fetched: 1, accepted: 1, duplicates: 0, rejected: 0 },
    { pollsterId: "emerson", raceId: "senate_2026", geographicId: "OH", runAt: minutesAgo(96), fetched: 1, accepted: 0, duplicates: 0, rejected: 1 },
  ];
  for (const r of runs) await store.logRun(r);

  const failures: Array<Parameters<PostgresPollStore["logFailure"]>[0]> = [
    {
      pollsterId: "emerson", sourceUrl: "https://emersoncollegepolling.com/",
      reason: "fetch_blocked", detail: "HTTP 403 from this environment's own egress proxy (host_not_allowed) -- see README.md, not an Emerson-side issue.",
      occurredAt: minutesAgo(96),
    },
    {
      pollsterId: "emerson", sourceUrl: "https://emersoncollegepolling.com/ohio-senate-2026/",
      reason: "candidate_share_out_of_range", detail: "Parsed share exceeded 100% -- see validation/validatePoll.ts.",
      occurredAt: minutesAgo(96),
    },
  ];
  for (const f of failures) await store.logFailure(f);

  console.log(`Seeded ${runs.length} ingestion_runs rows and ${failures.length} ingestion_failures rows.`);
  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
