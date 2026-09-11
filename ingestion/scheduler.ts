/**
 * ============================================================================
 * NOT RUNNING ANYWHERE. This file is a reference implementation of the scheduled job
 * described in spec item 6 (pollster -> adapter -> validation -> normalized database ->
 * polling calculations -> website), written against real, current APIs so it's ready to
 * deploy, not pseudocode.
 *
 * To make this actually run every 5-15 minutes, per item 6, it needs to be deployed as ONE
 * of (pick based on your hosting):
 *   - A Vercel Cron Job: vercel.json {"crons":[{"path":"/api/ingest","schedule":"every 10 minutes (standard 5-field cron syntax)"}]}
 *     calling an API route that runs runScheduledIngestion() below.
 *   - A Cloudflare Worker with a Cron Trigger: wrangler.toml [triggers] crons, same cadence.
 *   - A GitHub Actions scheduled workflow (cron field in .github/workflows/ingest.yml) hitting
 *     a small Node script that imports and calls this function.
 * None of those are configured in this project — there is no server for them to run on.
 * ============================================================================
 */
import { ingestAll, type PollStore } from "./pipeline";
import { ADAPTERS } from "../adapters/index";
import type { RaceId } from "../types/poll";

export interface ScheduledIngestionConfig {
  races: Array<{ raceId: RaceId; geographicId: string | null }>;
  store: PollStore;
  raceExists: (raceId: string, geographicId: string | null) => boolean;
  /** Called after every run so the caller can push results somewhere (logs, alerting,
   *  a metrics dashboard). Kept as a callback rather than a hard dependency on any one
   *  logging/monitoring vendor. */
  onComplete?: (summary: { totalFetched: number; totalAccepted: number; totalRejected: number; totalDuplicates: number; runCount: number }) => void | Promise<void>;
}

export async function runScheduledIngestion(config: ScheduledIngestionConfig) {
  const results = await ingestAll(ADAPTERS, config.races, config.store, config.raceExists);

  const summary = results.reduce(
    (acc, r) => ({
      totalFetched: acc.totalFetched + r.fetched,
      totalAccepted: acc.totalAccepted + r.accepted,
      totalRejected: acc.totalRejected + r.rejected,
      totalDuplicates: acc.totalDuplicates + r.duplicates,
      runCount: acc.runCount + 1,
    }),
    { totalFetched: 0, totalAccepted: 0, totalRejected: 0, totalDuplicates: 0, runCount: 0 }
  );

  if (config.onComplete) await config.onComplete(summary);
  return { results, summary };
}

/**
 * Example of how a deployed cron handler would call this (e.g. a Next.js API route at
 * /api/ingest, or the entry point of a Cloudflare Worker). Included so the "what's missing"
 * gap is a config/deploy step, not a code-writing step. NOT wired to any actual route here.
 */
export async function exampleCronHandler() {
  // In production: const store = new PostgresPollStore(process.env.DATABASE_URL);
  // In production: const races = await loadActiveRaces(); // from the same source races.json
  //                 already feeds the map, per "provider independence."
  throw new Error(
    "exampleCronHandler is illustrative only — it has no real PollStore or race source " +
    "wired in this environment. See ingestion/pipeline.ts InMemoryPollStore for the " +
    "interface a real Postgres-backed store needs to implement, and db/schema.sql for the schema."
  );
}
