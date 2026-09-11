// ============================================================================
// The data service between the persistent store and the map. Built on Node's built-in
// http module rather than a framework — "avoid unnecessary dependencies" (dev rules), and
// five routes don't need one. Reads from the same PostgresPollStore the scheduler writes to.
//
// Run with: DATABASE_URL=postgresql://... PORT=4001 INGEST_SECRET=... ALLOWED_ORIGINS=https://yoursite.com npx tsx api/server.ts
//
// Routes:
//   GET  /health                                            -> liveness check (for the host's health probe)
//   GET  /api/races                                         -> race list (id, geography, chamber)
//   GET  /api/polls?raceId=senate_2026&geographicId=IA      -> polls, in the map's row shape
//   GET  /api/polls/emerson?raceId=senate_2026              -> ALL Emerson-covered states' polls
//                                                                in one response, keyed by state
//                                                                (what the map actually fetches)
//   GET  /api/polls/average?raceId=...&geographicId=...     -> weighted average (weighting.ts, defaults)
//   GET  /api/ingestion-status?raceId=senate_2026           -> real counts from ingestion_runs /
//                                                                ingestion_failures, for the map's
//                                                                admin-only Data Center. Read-only
//                                                                aggregates, same openness as the
//                                                                routes above — gate it behind the
//                                                                INGEST_SECRET bearer check too if
//                                                                these counts shouldn't be public.
//   POST /api/ingest                                        -> run one ingestion pass now. Requires
//                                                                `Authorization: Bearer $INGEST_SECRET`
//                                                                — this is a public API; without auth,
//                                                                anyone could trigger repeated Emerson
//                                                                fetches through it.
//
// Deployment: this is one process serving plain HTTP. It can run as-is on any Node host
// (a VM, a container, Railway/Render/Fly), or the route bodies below can be lifted into
// framework-specific routes (Next.js API routes, Vercel/Cloudflare functions) with minimal
// change — they're already separated from the http-plumbing. See DEPLOYMENT.md.
// ============================================================================
import http from "http";
import { URL } from "url";
import { getPool } from "../db/connection";
import { PostgresPollStore, rowToPoll } from "../db/postgres-store";
import { weightedPollingAverage } from "../polling-average/weighting";
import { runIngestionPass } from "../ingestion/run-pass";
import { POLLSTERS } from "../config/pollsters";
import type { Poll } from "../types/poll";
import type { IngestionStatusResponse } from "./contract";

const PORT = Number(process.env.PORT) || 4001;
const INGEST_SECRET = process.env.INGEST_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!INGEST_SECRET) {
  console.warn("[api] WARNING: INGEST_SECRET is not set — POST /api/ingest will reject all requests until it is. Generate one with `openssl rand -hex 32` and set it as an env var on both this service and the scheduler that calls it.");
}
if (ALLOWED_ORIGINS.length === 0) {
  console.warn("[api] WARNING: ALLOWED_ORIGINS is not set — no cross-origin browser requests will be allowed (the map's fetch will fail with a CORS error) until it's set to the map's actual deployed origin, e.g. ALLOWED_ORIGINS=https://your-map-domain.com");
}

// ---- Poll -> the map's existing row shape (same conversion as the earlier manual pass,
// now applied automatically to whatever's actually in the persistent store) ----
interface MapPollRow {
  pollster: string; date: string; n: number | null; pop: string | null; moe: number | null;
  dem: number; rep: number; cand: string; src: string; houseLeanD?: number;
}
function pollToMapRow(poll: Poll, pollsterDisplayName: string): MapPollRow | null {
  const dem = poll.candidates.find(c => c.party === "D");
  const rep = poll.candidates.find(c => c.party === "R");
  if (!dem || !rep) return null; // not a clean two-party race; nothing sane to show the map
  return {
    pollster: pollsterDisplayName,
    date: poll.fieldEnd ?? poll.fieldStart ?? "unknown",
    n: poll.sampleSize,
    pop: poll.population === "unknown" ? null : poll.population,
    moe: poll.marginOfError,
    dem: dem.share,
    rep: rep.share,
    cand: `${dem.name.trim().split(/\s+/).at(-1)}/${rep.name.trim().split(/\s+/).at(-1)}`,
    src: poll.sourceUrl,
  };
}

// ---- CORS: echo back the request's Origin only if it's on the allowlist, never '*'.
// No Origin header (server-to-server calls, curl, the GitHub Actions cron) isn't a browser
// request, so it isn't subject to CORS at all — this only matters for browser fetches. ----
function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Vary": "Origin" };
  }
  return {};
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(req) });
  res.end(json);
}

// ---- Minimal in-memory rate limit for the ingest endpoint: even with the bearer-token
// check, this keeps one leaked/misused secret from being able to hammer Emerson's site by
// spamming this endpoint. Not distributed-safe (fine — this runs as one process). ----
let lastIngestAt = 0;
const MIN_INGEST_INTERVAL_MS = Number(process.env.MIN_INGEST_INTERVAL_MS) || 60_000;

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const { method, url: reqUrl } = req;

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const url = new URL(reqUrl ?? "/", `http://localhost:${PORT}`);
  res.on("finish", () => {
    console.log(`[api] ${method} ${url.pathname} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });

  try {
    if (method === "GET" && url.pathname === "/health") {
      return sendJson(req, res, 200, { ok: true });
    }

    const pool = getPool();

    if (method === "GET" && url.pathname === "/api/races") {
      const { rows } = await pool.query(`SELECT race_id AS "raceId", geographic_id AS "geographicId", chamber, election_day AS "electionDay" FROM races ORDER BY geographic_id`);
      return sendJson(req, res, 200, rows);
    }

    if (method === "GET" && url.pathname === "/api/polls") {
      const raceId = url.searchParams.get("raceId") ?? "senate_2026";
      const geographicId = url.searchParams.get("geographicId");
      if (!geographicId) return sendJson(req, res, 400, { error: "geographicId query param is required" });
      const store = new PostgresPollStore(pool);
      const polls = await store.getPollsForRace(raceId, geographicId);
      const { rows: pollsterRows } = await pool.query(`SELECT id, name FROM pollsters`);
      const nameById = new Map(pollsterRows.map((r: any) => [r.id, r.name]));
      const displayNames: Record<string, string> = { emerson: "Emerson College" }; // matches the map's existing short-form convention
      const rows = polls
        .map(p => pollToMapRow(p, displayNames[p.pollsterId] ?? nameById.get(p.pollsterId) ?? p.pollsterId))
        .filter((r): r is MapPollRow => r !== null);
      return sendJson(req, res, 200, { raceId, geographicId, polls: rows });
    }

    // Bulk variant: every Emerson-covered state's polls in one response. The map needs all
    // states' data up front (national view computes a model for all 35 races on load, not
    // lazily per click), so 11 separate round trips would be worse than one query grouped here.
    if (method === "GET" && url.pathname === "/api/polls/emerson") {
      const raceId = url.searchParams.get("raceId") ?? "senate_2026";
      const { rows: emersonRows } = await pool.query(
        `SELECT p.*,
                COALESCE(json_agg(json_build_object('name', c.candidate_name, 'party', c.party, 'share', c.share))
                         FILTER (WHERE c.candidate_name IS NOT NULL), '[]') AS candidates
         FROM polls p
         LEFT JOIN poll_candidates c ON c.poll_id = p.poll_id
         WHERE p.race_id = $1 AND p.pollster_id = 'emerson'
         GROUP BY p.poll_id`,
        [raceId]
      );
      const byState: Record<string, MapPollRow[]> = {};
      for (const row of emersonRows) {
        const poll = rowToPoll(row);
        const mapped = pollToMapRow(poll, "Emerson College");
        if (!mapped) continue;
        (byState[row.geographic_id] ??= []).push(mapped);
      }
      return sendJson(req, res, 200, { raceId, states: byState });
    }

    if (method === "GET" && url.pathname === "/api/polls/average") {
      const raceId = url.searchParams.get("raceId") ?? "senate_2026";
      const geographicId = url.searchParams.get("geographicId");
      if (!geographicId) return sendJson(req, res, 400, { error: "geographicId query param is required" });
      const store = new PostgresPollStore(pool);
      const polls = await store.getPollsForRace(raceId, geographicId);
      const avg = weightedPollingAverage(polls);
      return sendJson(req, res, 200, { raceId, geographicId, average: avg });
    }

    // Real counts only — every field here is either a genuine query result or an explicit
    // db.reachable:false, never a guess (spec item 21). Wraps its own queries in try/catch,
    // separate from this handler's outer one, because a DB hiccup here should be reported as
    // *data* ("the database isn't reachable") with a 200, not surfaced as a 500 to whatever's
    // rendering a status page from this — a monitoring endpoint that itself throws on the
    // exact condition it exists to report is not useful.
    if (method === "GET" && url.pathname === "/api/ingestion-status") {
      const raceId = url.searchParams.get("raceId") ?? "senate_2026";
      const checkedAt = new Date().toISOString();
      try {
        const [totals, recentRuns, lastByPollster, failCount, recentFailures, pollCount] = await Promise.all([
          pool.query(
            `SELECT COALESCE(SUM(fetched),0)::int AS fetched, COALESCE(SUM(accepted),0)::int AS accepted,
                    COALESCE(SUM(duplicates),0)::int AS duplicates, COALESCE(SUM(rejected),0)::int AS rejected
             FROM ingestion_runs WHERE race_id = $1 AND run_at > now() - interval '24 hours'`,
            [raceId]
          ),
          pool.query(
            `SELECT pollster_id AS "pollsterId", geographic_id AS "geographicId", run_at AS "runAt",
                    fetched, accepted, duplicates, rejected
             FROM ingestion_runs WHERE race_id = $1 ORDER BY run_at DESC LIMIT 15`,
            [raceId]
          ),
          pool.query(
            `SELECT DISTINCT ON (pollster_id) pollster_id AS "pollsterId", run_at AS "lastRunAt",
                    accepted AS "lastRunAccepted", rejected AS "lastRunFailures"
             FROM ingestion_runs WHERE race_id = $1 ORDER BY pollster_id, run_at DESC`,
            [raceId]
          ),
          pool.query(`SELECT COUNT(*)::int AS n FROM ingestion_failures WHERE occurred_at > now() - interval '24 hours'`),
          pool.query(
            `SELECT pollster_id AS "pollsterId", source_url AS "sourceUrl", reason, detail, occurred_at AS "occurredAt"
             FROM ingestion_failures ORDER BY occurred_at DESC LIMIT 10`
          ),
          pool.query(`SELECT COUNT(*)::int AS n FROM polls WHERE race_id = $1`, [raceId]),
        ]);

        const lastByPollsterMap = new Map(lastByPollster.rows.map((r: any) => [r.pollsterId, r]));
        const pollsters = POLLSTERS.map(p => {
          const last: any = lastByPollsterMap.get(p.id);
          return {
            pollsterId: p.id,
            name: p.name,
            ingestionMethod: p.ingestionMethod,
            hasAdapter: !!p.adapterId,
            lastRunAt: last?.lastRunAt ?? null,
            lastRunAccepted: last ? Number(last.lastRunAccepted) : null,
            lastRunFailures: last ? Number(last.lastRunFailures) : null,
          };
        });

        const response: IngestionStatusResponse = {
          checkedAt,
          db: { reachable: true },
          pollsters,
          totals24h: totals.rows[0],
          recentRuns: recentRuns.rows,
          failuresLast24h: failCount.rows[0].n,
          recentFailures: recentFailures.rows,
          totalPollsStored: pollCount.rows[0].n,
        };
        return sendJson(req, res, 200, response);
      } catch (err) {
        console.error(`[api] /api/ingestion-status query failed:`, err);
        const response: IngestionStatusResponse = {
          checkedAt, db: { reachable: false, error: "query failed — see server logs" },
          pollsters: [], totals24h: { fetched: 0, accepted: 0, duplicates: 0, rejected: 0 },
          recentRuns: [], failuresLast24h: 0, recentFailures: [], totalPollsStored: 0,
        };
        return sendJson(req, res, 200, response);
      }
    }

    if (method === "POST" && url.pathname === "/api/ingest") {
      if (!INGEST_SECRET) return sendJson(req, res, 503, { error: "INGEST_SECRET is not configured on this server" });
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${INGEST_SECRET}`) return sendJson(req, res, 401, { error: "unauthorized" });

      const now = Date.now();
      if (now - lastIngestAt < MIN_INGEST_INTERVAL_MS) {
        return sendJson(req, res, 429, { error: "rate limited", retryAfterMs: MIN_INGEST_INTERVAL_MS - (now - lastIngestAt) });
      }
      lastIngestAt = now;

      const summary = await runIngestionPass();
      return sendJson(req, res, 200, summary);
    }

    sendJson(req, res, 404, { error: "not found" });
  } catch (err) {
    // Full detail server-side; a generic message to the client so internal errors (which
    // could, in principle, echo back query fragments or stack traces) never leak details.
    console.error(`[api] error handling ${method} ${url.pathname}:`, err);
    sendJson(req, res, 500, { error: "internal error" });
  }
});

// Request/header timeouts: without these, a slow or hung client connection can tie up a
// server socket indefinitely.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;

server.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));

process.on("SIGTERM", () => { console.log("[api] SIGTERM received, shutting down."); server.close(() => process.exit(0)); });
