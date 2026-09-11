// ============================================================================
// The real, single-invocation ingestion pass. No test doubles, no pre-fetched content —
// ADAPTERS is the real adapters/index.ts registry (Emerson only, per "start with Emerson
// only" — adding a pollster later means adding one line there, nothing here changes), and
// emersonAdapter.fetchLatestPolls does a real fetch() to emersoncollegepolling.com.
//
// Called by:
//   - ingestion/scheduler-daemon.ts, on a recurring interval (long-running process — an
//     alternative to the recommended deployment below)
//   - api/server.ts's POST /api/ingest, which is what the recommended deployment actually
//     uses: a platform cron (GitHub Actions, by default — see .github/workflows/ingest.yml)
//     hits that endpoint every few minutes instead of keeping a process alive.
// Both callers invoke this exact function — the schedule mechanism is just what invokes it.
// ============================================================================
import { getPool } from "../db/connection";
import { PostgresPollStore } from "../db/postgres-store";
import { ingestOne } from "./pipeline";
import { ADAPTERS } from "../adapters/index";
import { POLLSTERS } from "../config/pollsters";
import type { RaceId, IngestionRunResult } from "../types/poll";

export interface PassSummary {
  runAt: string;
  results: IngestionRunResult[];
  totalFetched: number;
  totalAccepted: number;
  totalDuplicates: number;
  totalRejected: number;
}

const INTER_RACE_DELAY_MS = Number(process.env.INGEST_INTER_RACE_DELAY_MS) || 400;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runIngestionPass(): Promise<PassSummary> {
  const pool = getPool();
  const store = new PostgresPollStore(pool);

  const { rows: raceRows } = await pool.query<{ race_id: RaceId; geographic_id: string | null }>(
    `SELECT race_id, geographic_id FROM races WHERE race_id = 'senate_2026'`
  );
  const races = raceRows.map(r => ({ raceId: r.race_id, geographicId: r.geographic_id }));
  const raceIdSet = new Set(raceRows.map(r => `${r.race_id}::${r.geographic_id ?? ""}`));
  const raceExists = (raceId: string, geographicId: string | null) => raceIdSet.has(`${raceId}::${geographicId ?? ""}`);

  // Explicit pollster x race loop (rather than ingestAll's flat result array) so we always
  // know which race a given result belongs to, for the ingestion_runs audit log below —
  // ingestAll's IngestionRunResult doesn't carry geographicId, so zipping its output back to
  // races only works by coincidence while there's exactly one adapter-backed pollster.
  const results: IngestionRunResult[] = [];
  for (const pollster of POLLSTERS.filter(p => p.approved)) {
    const adapter = pollster.adapterId ? ADAPTERS[pollster.adapterId] : undefined;
    if (!adapter) continue; // manual-only pollster; nothing to run automatically yet

    for (const race of races) {
      let result: IngestionRunResult;
      try {
        result = await ingestOne(adapter, race, store, raceExists);
      } catch (err) {
        // A single race's unexpected failure (e.g. a dropped DB connection mid-query) must
        // not abort the rest of the pass — the other ~10 states deserve their own attempt.
        // ingestOne already catches fetch/adapter errors internally; this catches everything
        // else (store errors, etc.) so one bad race can't take the whole pass down with it.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ingest] unexpected error for ${pollster.id}/${race.geographicId}:`, message);
        result = {
          pollsterId: pollster.id, raceId: race.raceId, runAt: new Date().toISOString(),
          fetched: 0, accepted: 0, duplicates: 0, rejected: 0,
          failures: [{ pollsterId: pollster.id, reason: "unexpected_error", detail: message, occurredAt: new Date().toISOString() }],
        };
      }
      results.push(result);

      try {
        await store.logRun({
          pollsterId: result.pollsterId, raceId: result.raceId, geographicId: race.geographicId,
          runAt: result.runAt, fetched: result.fetched, accepted: result.accepted,
          duplicates: result.duplicates, rejected: result.rejected,
        });
      } catch (err) {
        // Audit logging failing shouldn't be treated as the ingestion itself failing.
        console.error(`[ingest] failed to write ingestion_runs audit row for ${pollster.id}/${race.geographicId}:`, err);
      }

      // A small gap between requests to the same pollster — a real source shouldn't see a
      // burst of ~10 near-simultaneous requests every time this runs.
      await delay(INTER_RACE_DELAY_MS);
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      totalFetched: acc.totalFetched + r.fetched,
      totalAccepted: acc.totalAccepted + r.accepted,
      totalDuplicates: acc.totalDuplicates + r.duplicates,
      totalRejected: acc.totalRejected + r.rejected,
    }),
    { totalFetched: 0, totalAccepted: 0, totalDuplicates: 0, totalRejected: 0 }
  );

  return { runAt: new Date().toISOString(), results, ...totals };
}
