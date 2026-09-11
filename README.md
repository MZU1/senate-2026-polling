# Polling ingestion architecture — status report

Emerson, end to end, for real: official page -> adapter -> validation -> dedup -> **persistent
Postgres store** -> **HTTP API** -> **the map fetches it live** instead of having it hardcoded.
Every other pollster is still the map's original hand-compiled snapshot, untouched, per
"start with Emerson only."

## Run it yourself

```
npm install
npx tsc --noEmit                        # 0 errors across the whole codebase

# unit/integration tests (no DB required)
npx tsx test/emerson.test.ts            # real adapter vs. two real fetched pages (IA, TX -- different phrasing)
npx tsx test/emerson-extraction.test.ts # Readability HTML extraction vs. a realistic synthetic page
npx tsx test/dedupe.test.ts
npx tsx test/validate.test.ts
npx tsx test/weighting.test.ts
npx tsx test/pipeline.test.ts

# the real system (needs Postgres -- see below)
export DATABASE_URL=postgresql://app:PASSWORD@HOST:5432/elections_polling
npx tsx db/seed.ts /path/to/3senate-2026-magic-wall.tsx   # one-time: pollsters + races
npx tsx api/server.ts                    # the data service, port 4001 by default
npx tsx ingestion/scheduler-daemon.ts    # the recurring ingestion loop (long-lived process)
```

All 6 test suites pass, 58 assertions total. Everything below "the real system" was run
against an actual local Postgres 16 instance this session, not simulated -- see "What was
actually run and verified" below for the specific commands and results.

## What changed this session

- **`adapters/emerson.ts`**: fixed a real bug -- `fetchLatestPolls()` was feeding raw HTML
  into a plain-text parser (a `text = html` placeholder). Now runs real Readability+jsdom
  extraction. Also generalized the Senate-sentence regex: Iowa's release says "...for U.S.
  Senate, 48% support..." but Texas's says "...the U.S. Senate race in a dead heat: 47%
  support..." -- the original pattern only matched Iowa's phrasing. Now scans a window after
  any "U.S. Senate" mention rather than requiring that exact prefix. Both real pages parse
  correctly now; see `test/emerson.test.ts`.
- **`db/connection.ts`, `db/postgres-store.ts`, `db/seed.ts`** (new): a real `PollStore`
  implementation against `db/schema.sql` (unmodified), plus a one-time seed script that loads
  pollsters from `config/pollsters.ts` and races from the map's own `RACES` data.
- **`ingestion/run-pass.ts`** (new): the real single-pass function -- real `ADAPTERS` (Emerson
  only), real `PostgresPollStore`, races read from the database. This is what both the
  scheduler and the API's manual-trigger endpoint call.
- **`ingestion/scheduler-daemon.ts`** (new): a real, dependency-free recurring scheduler
  (self-rescheduling `setTimeout`, not `node-cron` -- one less dependency). Ran it for real
  this session; see below.
- **`api/server.ts`** (new): a real HTTP API (Node's built-in `http`, no framework) serving
  `/api/races`, `/api/polls`, `/api/polls/emerson` (bulk), `/api/polls/average`, and
  `POST /api/ingest`.
- **The map** (`3senate-2026-magic-wall.tsx`): `POLLS` renamed to `STATIC_POLLS` (unchanged,
  still the baseline for every non-Emerson pollster). Added a `useEffect` that fetches
  `/api/polls/emerson` once on mount and a `useMemo` that overlays those rows onto the static
  baseline -- Emerson's data is no longer hardcoded; everything else is exactly as before if
  the API is unreachable. The methodology text no longer claims "nothing here is a live API
  call" -- it now says which pollster is live and reports honestly when the service is down.
  Total diff: 74 lines changed out of 941, all in one file, none of it touching map/zoom/county
  rendering or interaction code.

## What was actually run and verified this session (not simulated)

- Installed Postgres 16 in this dev environment, created a real `app`/`elections_polling`
  database (not the superuser), ran `db/schema.sql` unmodified against it, seeded it with the
  real pollster and race data.
- **Tried the real network fetch for real**: `emersonAdapter.fetchLatestPolls()` against
  `emersoncollegepolling.com` from this dev sandbox returns `403`, body `Host not in
  allowlist: emersoncollegepolling.com`, header `x-deny-reason: host_not_allowed`. That's
  this sandbox's own egress proxy blocking the domain -- not Emerson, not a code bug. Ran the
  real scheduler daemon for ~20s at a short interval; it fired 3 times unattended, and each
  time correctly logged 11 real `403` failures to `ingestion_failures` instead of fabricating
  anything or crashing.
- To verify everything *downstream* of a successful fetch (which this sandbox cannot produce),
  `integration/verify-downstream-with-live-fetch.ts` substitutes real, previously live-fetched
  Emerson text (`integration/live-fetches/*.txt`, fetched 2026-08-26 via a tool with different
  network access) for the network call only -- every function after that (`parseEmersonPost`,
  `validatePoll`, `isDuplicateOfExisting`, `ingestOne`, the real Postgres write) is the exact
  same unmodified code the production path uses. **This script is not part of the deployed
  system** -- nothing in `scheduler-daemon.ts` or `api/server.ts` calls it.
  Result: real rows landed in Postgres; re-running it correctly deduped instead of
  double-inserting; `GET /api/polls/average?geographicId=IA` computed a real weighted margin
  from those rows via `polling-average/weighting.ts`.
- `integration/verify-map-merge-logic.js` replays the map component's exact fetch+merge logic
  against the real running API: confirms Iowa and Texas get live-sourced Emerson rows with
  every other pollster's row for those states untouched, and confirms a state with no live
  Emerson data (checked: North Carolina) comes back byte-identical to the static baseline.

## What "deployed for real" still requires

Nothing above is a public deployment -- it's real code, run and verified against a real local
database in this session. To actually go live:

1. **A real, persistent Postgres instance somewhere that survives restarts** -- Neon, Supabase,
   RDS, a self-managed instance, anything. Point `DATABASE_URL` at it and run `db/seed.ts`
   once. (What was verified here was a local Postgres in a dev sandbox; that specific instance
   does not persist between sessions -- the schema and seed script are what need re-running
   against wherever this actually gets hosted.)
2. **Normal outbound network access to emersoncollegepolling.com.** The only thing that failed
   this session was this sandbox's own egress allowlist -- a real server/VM/container host
   should reach it fine. Worth actually confirming once deployed, the same way this session
   did (`curl -I https://emersoncollegepolling.com/`), rather than assuming.
3. **Something to keep `scheduler-daemon.ts` alive continuously** -- a systemd unit, a Docker
   container with a restart policy, pm2, or a platform's background-worker primitive
   (Railway/Render/Fly/an EC2 box). Plain `node`/`tsx` processes don't survive on their own.
   Alternative: skip the always-on daemon and instead point a platform's own cron primitive
   (Vercel Cron, a scheduled GitHub Actions workflow, a Cloudflare Cron Trigger) at
   `POST /api/ingest` on whatever interval you want -- same underlying `runIngestionPass()`
   either way, so this choice doesn't touch application code.
4. **Somewhere to run `api/server.ts`** reachable by the deployed map, and
   `NEXT_PUBLIC_POLLING_API_BASE` (or equivalent) set on the map's build to point at it. It's
   plain Node `http`, so it runs as-is on any Node host, or its four handlers can be lifted
   into framework-specific routes (Next.js API routes, Vercel/Cloudflare functions) with
   minimal change.

## Pollster registry -- 13 requested, 1 with a real adapter, 12 honestly not

- **Emerson**: real adapter, real HTML extraction, tested against two real fetched pages with
  different phrasing, now wired to a real database and a real API the map actually reads from.
- **YouGov, Fox News, SurveyUSA, Susquehanna, Data for Progress, TIPP, InsiderAdvantage,
  St. Anselm, High Point, EPIC-MRA**: `ingestionMethod: "source_page_adapter"` -- the right
  approach given how these sites work, not built yet. Adding one is: write `adapters/<id>.ts`
  (Emerson's is the template), add one line to `adapters/index.ts`. Nothing else changes --
  `run-pass.ts`, the scheduler, the API, and the map's merge logic all already iterate over
  whichever pollsters have a registered adapter.
- **Siena (NYT/Siena), Fabrizio Ward/Impact Research**: marked `ingestionMethod: "manual"` --
  NYT's pages are paywalled/JS-rendered, Fabrizio/Impact don't publish standalone release
  pages the way Emerson does. Would need a different approach (an NYT API license, etc.) or
  to stay manual indefinitely -- a legitimate, common choice.

## A bug the tests caught (worth reading, not just believing)

My first version of `isSamePoll()` required merged records' candidate shares to match within
3 points before treating them as duplicates. Testing it against real PollingSource data (three
"High Point University" listings for one NC release -- a 660-respondent LV cut at 50/45, an
800-respondent RV cut at 48/41, and an unlabeled variant matching the LV numbers) showed the
RV cut sitting *outside* that tolerance, so my first version kept it as a separate "poll" --
silently double-counting one survey. The fix: group by (pollster, race, field-end date) only,
and let `pickCanonical()` choose the best cut (LV preferred), with a `discrepancies` array so
callers can see when merged variants disagreed by more than 3 points rather than that spread
disappearing silently.

This session's equivalent: `extractSenateRace`'s original regex only matched Iowa's exact
phrasing; testing the *real* Texas release (not just the Iowa fixture) against it showed it
silently returning `null` -- the adapter would have thrown "no Senate result sentence found"
on a perfectly valid, differently-worded release. Caught by testing against a second real
page, not by re-reading the first one more carefully.

## GET /api/ingestion-status -- from sketch to real, and verified end-to-end

`api/contract.ts` had sketched an `IngestionStatusResponse` shape but noted nothing called it.
It's now implemented for real in `api/server.ts`, reading `ingestion_runs` and
`ingestion_failures` -- both tables already existed and were already being written to by
`run-pass.ts` via `store.logRun()`/`store.logFailure()`, just never read from. It backs the
map's admin-only Data Center (`?admin=1`), which now shows real per-pollster last-run status,
real 24h accepted/duplicate/rejected totals, and a real failure log instead of the placeholder
"not exposed by this API" text -- and still shows that exact placeholder text if this endpoint
isn't reachable, same honest-fallback pattern as the rest of the map.

What was actually run this session, in this sandbox, not just written:
- Installed Postgres 16 fresh, ran `db/schema.sql` for real, ran `db/seed.ts` against the
  actual current map file (seeded 13 pollsters, 35 races -- confirming the map/DB seed
  contract still matches after the map file's grown since the last session).
- Added `db/seed-ingestion-history.ts` (a dev-only helper, not called by the deployed system)
  to populate realistic `ingestion_runs`/`ingestion_failures` rows through the real
  `PostgresPollStore` methods -- not raw INSERTs bypassing the application code the real
  routes call -- since this sandbox's egress proxy still blocks emersoncollegepolling.com
  the same way it did last session, so a real live Emerson fetch isn't possible here either.
- Started the real `api/server.ts` and curled `/api/ingestion-status` -- got back the real
  seeded counts.
- Stopped Postgres mid-session and queried again: got `200` with `db.reachable: false` and an
  error string, not a crash or a `500` -- confirmed the process itself stayed up (the pool's
  `error` handler absorbed it) and that a monitoring endpoint reporting its own dependency's
  outage doesn't itself go down. Restarted Postgres, queried a third time with no server
  restart: recovered to `db.reachable: true` automatically.
- `npx tsc --noEmit` and all 6 test suites still pass after these changes.

Not verified: this endpoint against real (non-seeded) Emerson-sourced rows, and its behavior
under concurrent ingestion runs writing to the same tables it's reading from -- both should be
fine given the existing connection pooling, but "should be fine" isn't "verified," so flagging
it rather than implying otherwise.

## Provider independence / live-ready architecture

`RaceId` is a free-form string (`"senate_2026"`, `"house_2026"`, `"governor_2026"`,
`"president_2028"` all work today with zero code changes) precisely so House/Governor/
President races and future years don't require touching this layer. The map/UI never imports
anything from `adapters/` or `ingestion/` directly -- it only ever sees poll rows over HTTP, so
swapping how those rows got there (in-memory -> Postgres, no API -> a real one) didn't touch
map rendering or interaction code, only the ~70 lines around where it gets its data.
