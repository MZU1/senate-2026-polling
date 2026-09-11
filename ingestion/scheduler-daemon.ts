// ============================================================================
// A real, invokable recurring scheduler — not a reference sketch. Run it with:
//   DATABASE_URL=postgresql://... INGEST_INTERVAL_MS=1800000 npx tsx ingestion/scheduler-daemon.ts
//
// This is a long-lived Node process: it calls runIngestionPass() once immediately, then again
// every INGEST_INTERVAL_MS (default 30 min — reasonable for a handful of press-release pages
// that update at most a few times a week), for as long as the process stays alive. It needs
// to be KEPT alive by whatever's hosting it — a systemd unit, a Docker container with a
// restart policy, pm2, or a platform's "worker"/"background process" primitive (Railway,
// Render, Fly.io, an EC2/Droplet instance). Plain Node scripts don't survive process exit,
// server restarts, or serverless cold-starts on their own — that persistence is the one
// piece of infrastructure this script cannot provide for itself; see integration/README.md
// "What's still needed to deploy this for real" for the concrete options and trade-offs
// (this always-on daemon vs. a serverless cron hitting POST /api/ingest once per interval —
// both call the exact same runIngestionPass(), so the choice doesn't touch this file).
//
// Uses setTimeout-based self-rescheduling (not setInterval) specifically so a slow pass can't
// cause overlapping runs — the next run is scheduled only after the current one finishes.
// ============================================================================
import { runIngestionPass } from "./run-pass";

const INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS) || 30 * 60 * 1000;

let stopped = false;
let runCount = 0;

async function tick() {
  if (stopped) return;
  runCount++;
  const startedAt = new Date().toISOString();
  console.log(`[scheduler] run #${runCount} starting at ${startedAt}`);
  try {
    const summary = await runIngestionPass();
    console.log(
      `[scheduler] run #${runCount} complete: fetched=${summary.totalFetched} accepted=${summary.totalAccepted} ` +
      `duplicates=${summary.totalDuplicates} rejected=${summary.totalRejected}`
    );
    for (const r of summary.results) {
      if (r.failures.length > 0) {
        for (const f of r.failures) console.log(`[scheduler]   failure: pollster=${r.pollsterId} race=${r.raceId} reason=${f.reason} detail=${f.detail ?? ""}`);
      }
    }
  } catch (err) {
    console.error(`[scheduler] run #${runCount} threw an unexpected error:`, err);
  }
  if (!stopped) setTimeout(tick, INTERVAL_MS);
}

console.log(`[scheduler] starting. interval=${INTERVAL_MS}ms (${(INTERVAL_MS / 60000).toFixed(1)} min)`);
tick();

process.on("SIGTERM", () => { console.log("[scheduler] SIGTERM received, stopping after current run."); stopped = true; });
process.on("SIGINT", () => { console.log("[scheduler] SIGINT received, stopping after current run."); stopped = true; });
