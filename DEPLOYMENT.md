# Deploying the Emerson pipeline for real

This is the deployment layer on top of what README.md already describes as built and
verified. Nothing in the pipeline's logic changed for this — this is purely: harden it
(auth, CORS, timeouts, connection handling) and wire it to real hosted infrastructure.

## Chosen architecture, and why

| Piece | Choice | Why |
|---|---|---|
| Database | **Neon** (Postgres) | Free tier, plain Postgres (schema.sql runs unmodified), no code changes vs. Supabase — either works, Neon is simplest for "just Postgres." |
| API | **Render** (free Web Service) | Plain `npx tsx api/server.ts`, no build step beyond `npm install`, free tier, HTTPS automatic. Trade-off: free tier spins down after ~15 min idle (see below). |
| Scheduler | **GitHub Actions** (`schedule` cron), hitting `POST /api/ingest` | Free, needs no always-on process. Vercel Cron would be simpler if you're already on Vercel, but its Hobby (free) tier only allows once-per-day cron — not "every few minutes." Render also has a Cron Jobs feature but it isn't on the free tier. GitHub Actions is the only free option that supports minutes-level scheduling. |
| Frontend hosting | Wherever you already deploy the map | Unchanged by this task — only needs one env var (`NEXT_PUBLIC_POLLING_API_BASE`, or your bundler's equivalent) pointed at the Render URL. |

Everything above is swappable — Supabase instead of Neon, Railway/Fly instead of Render,
a self-hosted cron instead of GitHub Actions — none of it is baked into the application
code. `DATABASE_URL`, `INGEST_SECRET`, and `ALLOWED_ORIGINS` are the only integration points.

**Total cost at this scale: $0/month**, with one real caveat (below).

### The one real trade-off: Render free tier cold starts

Render's free Web Service spins down after ~15 minutes with no incoming requests, and takes
roughly 30-60 seconds to wake up on the next one. Practically:
- The GitHub Actions cron hitting `/api/ingest` every 10 minutes will keep it awake most of
  the time by itself, once running.
- The map's own visitors hitting the API cold would see a slow first load (30-60s) rather
  than a failure — not ideal, but not broken.
- If that latency is unacceptable: Render's Starter plan (~$7/mo at time of writing) keeps
  it always-on. Nothing else about this setup changes if you upgrade later.

## 1. Database (Neon)

1. Create a free account at neon.tech, create a project.
2. Copy the connection string from the dashboard — looks like
   `postgresql://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require`.
3. Run the schema once (from your machine, with `psql` installed, or Neon's own SQL editor
   in their dashboard — paste the contents of `db/schema.sql`):
   ```
   psql "postgresql://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require" -f db/schema.sql
   ```
4. Seed pollsters + races (needs Node/npx locally, or run this as a one-off from wherever
   you deploy the API — it's idempotent, safe to re-run):
   ```
   DATABASE_URL="postgresql://user:password@ep-xxx.../dbname?sslmode=require" \
     npx tsx db/seed.ts /path/to/3senate-2026-magic-wall.tsx
   ```
   This is the only step that needs the map file present — it just reads `RACES` out of it.

There is no ongoing migration tooling here (no Prisma/Drizzle migrations) — `schema.sql` is
the entire schema, run once. If you change it later, you'll write the `ALTER TABLE`
statements by hand and run them the same way. Fine at this scale; worth reconsidering only
if the schema starts changing often.

## 2. API (Render)

1. Push this repo to GitHub (Render deploys from a git repo; this also gives GitHub Actions
   somewhere to run from — steps 1 and 3 share this prerequisite).
2. In Render: New -> Blueprint -> connect the repo. Render reads `render.yaml` and creates
   the `polling-api` service automatically (free plan, health check on `/health`).
   (No `render.yaml`/Blueprint access, or prefer clicking through manually? New -> Web
   Service -> same repo -> Build Command `npm install`, Start Command `npx tsx api/server.ts`.)
3. In the service's Environment tab, set:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `INGEST_SECRET` — generate with `openssl rand -hex 32`
   - `ALLOWED_ORIGINS` — the map's actual deployed domain, e.g. `https://your-map-domain.com`
     (comma-separate if there's more than one, e.g. a production + preview domain)
4. Deploy. Render gives you a URL like `https://polling-api-xxxx.onrender.com` — that's your
   `API_BASE_URL`.
5. Verify: `curl https://polling-api-xxxx.onrender.com/health` -> `{"ok":true}`.

## 3. Scheduler (GitHub Actions)

Already written: `.github/workflows/ingest.yml`. It needs two repo secrets (GitHub repo ->
Settings -> Secrets and variables -> Actions -> New repository secret):
- `INGEST_SECRET` — the exact same value you set on Render in step 2.3
- `API_BASE_URL` — the Render URL from step 2.4 (no trailing slash)

That's it — once those two secrets exist and the workflow file is on the default branch, it
starts running every 10 minutes automatically. Trigger one manually first to confirm it
works: repo -> Actions tab -> "Emerson polling ingestion" -> Run workflow.

Real caveats (also noted in the workflow file itself): GitHub doesn't guarantee exact
timing under load (usually within a few minutes, occasionally more), and disables scheduled
workflows automatically after 60 days of no repository activity on the default branch —
worth knowing if this repo goes quiet for two months.

## 4. Frontend

One env var, set at build time on wherever the map itself is deployed:
```
NEXT_PUBLIC_POLLING_API_BASE=https://polling-api-xxxx.onrender.com
```
(That's the Next.js convention, matching this project's SEO goals from CURRENT_STATE.md; if
the map ends up built with Vite or CRA instead, the equivalent is `VITE_POLLING_API_BASE`
read via `import.meta.env`, or `REACT_APP_POLLING_API_BASE` — one line to adjust in the map
file if so, at the `POLLING_API_BASE` constant near the top.)

If this env var is never set, `POLLING_API_BASE` is `""`, and the fetch goes to a relative
`/api/polls/emerson` path — works only if the API happens to be reachable at the same origin
as the frontend. In every other case, set the env var.

**Static fallback is unchanged from before**: if the API is unreachable, slow past whatever
timeout the browser gives it, or `ALLOWED_ORIGINS` doesn't include the map's domain (a CORS
error), the map falls back to `STATIC_POLLS` exactly as it did before this task — no crash,
no blank state, just the pre-existing hand-compiled data.

## 5. Verification checklist — what's actually confirmed vs. what needs your accounts

**Verified locally, this session** (see README.md "What was actually run and verified" for
the specific commands): schema + seed run against a real local Postgres; the hardened API's
auth/CORS/rate-limiting all behave correctly under real HTTP requests; a real ingestion pass
correctly logs real fetch failures instead of fabricating data (this sandbox can't reach
Emerson — see README); everything downstream of a successful fetch (validate -> dedupe ->
persist -> average -> API -> map merge logic) verified against real, previously-fetched
Emerson content.

**Cannot be verified without your accounts** (nothing about this is a code gap — it
requires infrastructure only you can provision):
- That Neon/Render actually work as described *for this specific project* — the connection
  strings, exact free-tier behavior, and Render's cold-start timing are all as documented by
  those providers as of this writing, not independently re-verified against a live account
  here.
- That GitHub Actions can actually reach your specific Render URL and that the full
  cron -> API -> Postgres -> map round trip works with real production credentials.
- Whether Emerson's site is reachable from Render's network the way it wasn't from this
  sandbox — should just work (Render is a normal outbound-internet host), worth confirming
  once deployed with the manual-trigger button in step 3.

**What you'll need to do yourself**, because I can't create accounts or hold real credentials
on your behalf: see the short checklist below.

## What you personally need to do

1. **Neon**: sign up (free) at neon.tech, create a project, copy the connection string.
2. Run once, from your machine: `psql "<neon-connection-string>" -f db/schema.sql`, then
   `DATABASE_URL="<neon-connection-string>" npx tsx db/seed.ts /path/to/3senate-2026-magic-wall.tsx`.
3. **Render**: sign up (free) at render.com, connect this GitHub repo, deploy via
   `render.yaml` (Blueprint) or manually (Node web service, `npm install` / `npx tsx api/server.ts`).
4. On Render, set env vars: `DATABASE_URL` (from step 1), `INGEST_SECRET` (generate:
   `openssl rand -hex 32`), `ALLOWED_ORIGINS` (your map's real domain).
5. **GitHub**: on this repo, add two Actions secrets: `INGEST_SECRET` (same value as step
   4), `API_BASE_URL` (the Render URL Render gives you after deploying).
6. On wherever the map itself builds/deploys, set `NEXT_PUBLIC_POLLING_API_BASE` to the
   same Render URL.
7. Push to GitHub / trigger a deploy. Confirm: `curl https://<render-url>/health`, then
   manually run the GitHub Action once (Actions tab -> Run workflow) and check its logs.
