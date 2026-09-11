import type { Poll, RaceId } from "../types/poll";

/**
 * ============================================================================
 * Contracts a real backend exposes. Status varies by interface — check each one's own
 * comment: GetPollsResponse and the SSE sketch are still just the shape a future handler
 * would use, not deployed. IngestionStatusResponse is now real — implemented in
 * api/server.ts's GET /api/ingestion-status and backed by the ingestion_runs /
 * ingestion_failures tables in db/schema.sql, which the scheduler/api's POST /api/ingest
 * path already writes to via db/postgres-store.ts's logRun()/logFailure().
 * ============================================================================
 */

// GET /api/polls?raceId=senate_2026&geographicId=NC
export interface GetPollsResponse {
  raceId: RaceId;
  geographicId: string | null;
  polls: Poll[];
  lastIngestedAt: string | null; // for an honest "data as of" timestamp, not a fake "live" badge
}

// GET /api/ingestion-status?raceId=senate_2026 — implemented for real in api/server.ts.
// Powers the map's admin-only Data Center (spec item 12) and, more generally, spec item 10
// ("don't pretend it's live"): every field here is either a real query result or an explicit
// `reachable: false` / error, never a filled-in guess.
export interface IngestionStatusResponse {
  checkedAt: string; // when this response was computed, not when any underlying row changed
  db: { reachable: boolean; error?: string };
  pollsters: Array<{
    pollsterId: string;
    name: string;
    ingestionMethod: string;
    hasAdapter: boolean;
    lastRunAt: string | null;
    lastRunAccepted: number | null;
    lastRunFailures: number | null;
  }>;
  totals24h: { fetched: number; accepted: number; duplicates: number; rejected: number };
  recentRuns: Array<{
    pollsterId: string; geographicId: string | null; runAt: string;
    fetched: number; accepted: number; duplicates: number; rejected: number;
  }>;
  failuresLast24h: number;
  recentFailures: Array<{ pollsterId: string; sourceUrl: string | null; reason: string; detail: string | null; occurredAt: string }>;
  totalPollsStored: number;
}

/**
 * "Frontend should automatically receive updated polling data without a page reload" (item 6).
 * The realistic options, in order of how much infrastructure they need:
 *   1. Polling: frontend calls GET /api/polls every N minutes with fetch(). Simplest, works
 *      everywhere, is "live" within N minutes — fine for a polling-average use case where
 *      nothing needs sub-minute latency.
 *   2. Server-Sent Events: one persistent GET the server pushes to when new polls land.
 *      Simpler than WebSockets for one-directional updates like this.
 *   3. WebSockets: only worth it if you also want bidirectional traffic (e.g. live chat
 *      alongside results) — overkill for polling-average updates alone.
 * Sketched below is (2), since it's the best fit for this specific use case. Not wired to
 * an actual server or to the map artifact.
 */
export function exampleSSEHandlerSketch() {
  // Illustrative Node/Express-style handler — NOT executable without a real server, a real
  // PollStore, and a real pub/sub mechanism (e.g. Postgres LISTEN/NOTIFY, or Redis) to know
  // when to push. Included so the shape is concrete, not hand-waved.
  return `
    app.get('/api/polls/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const raceId = req.query.raceId;
      const unsubscribe = pollStorePubSub.subscribe(raceId, (newPoll) => {
        res.write(\`data: \${JSON.stringify(newPoll)}\\n\\n\`);
      });
      req.on('close', unsubscribe);
    });
  `.trim();
}
