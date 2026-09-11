// ============================================================================
// Connects the polling architecture to the actual map — Emerson, end to end.
//
// Pollster (Emerson) -> adapter (parseEmersonPost) -> validation (validatePoll) ->
// dedup against what's already live (isDuplicateOfExisting) -> normalized Poll ->
// converted to the map's own poll-row shape -> spliced into the map's POLLS object.
//
// This is not a standalone backend. There is no database and this script isn't on a
// schedule. It reads the website's own current data as the "store" it reconciles
// against, and its output is a patch applied directly to the map file. What a real
// deployed cron worker (ingestion/scheduler.ts) would do differently: it would call
// emersonAdapter.fetchLatestPolls() itself (real fetch(), real HTML->text step) and
// write to a real PollStore (Postgres, per db/schema.sql) instead of reading/writing
// the map file directly. Neither of those exists yet — see README "What making this
// live actually requires." This script is the wiring for the piece that *is* real:
// a genuine Emerson release, actually parsed, actually validated, actually deduped.
//
// LIVE_PAGES below is real text fetched from emersoncollegepolling.com on 2026-08-26
// (integration/live-fetches/*.txt) — not the test fixtures, not invented. It is fed to
// the adapter's exported parser directly because this sandbox's network egress doesn't
// reach emersoncollegepolling.com; a deployed worker would call fetch() itself and skip
// this step. The parsing/validation/dedup code that runs on it afterward is untouched
// production code, the same code test/emerson.test.ts exercises.
// ============================================================================

import fs from "fs";
import path from "path";
import { parseEmersonPost } from "../adapters/emerson";
import { validatePoll, type RaceExistsFn } from "../validation/validatePoll";
import { isDuplicateOfExisting } from "../validation/dedupe";
import { ingestOne, type PollStore } from "../ingestion/pipeline";
import type { Poll, RawPollRecord, IngestionRunResult, RaceId } from "../types/poll";
import type { PollAdapter } from "../adapters/base";

const ROOT = path.join(__dirname, "..");
const LIVE_DIR = path.join(__dirname, "live-fetches");

const LIVE_PAGES: Record<string, { file: string; url: string }> = {
  IA: { file: "emerson-IA-2026-08-26.txt", url: "https://emersoncollegepolling.com/iowa-2026-poll/" },
  TX: { file: "emerson-TX-2026-08-26.txt", url: "https://emersoncollegepolling.com/texas-2026-poll-paxton-and-talarico/" },
};

// ---- Adapter: real parser, pre-fetched real text (see header note) ----
const liveEmersonAdapter: PollAdapter = {
  pollsterId: "emerson",
  async fetchLatestPolls(race) {
    const page = race.geographicId ? LIVE_PAGES[race.geographicId] : undefined;
    if (!page) return [];
    const text = fs.readFileSync(path.join(LIVE_DIR, page.file), "utf8");
    return [parseEmersonPost(text, page.url, { raceId: race.raceId, geographicId: race.geographicId })];
  },
};

// ---- Map's row shape (what POLLS[state][i] actually looks like today) ----
interface MapPollRow {
  pollster: string;
  date: string;
  n: number | null;
  pop: string | null;
  moe: number | null;
  dem: number;
  rep: number;
  cand: string;
  lean?: "D" | "R";
  houseLeanD?: number;
  src: string;
}

const mapPolls: Record<string, MapPollRow[]> = JSON.parse(fs.readFileSync(path.join(__dirname, "map-polls-snapshot.json"), "utf8"));
const mapRaces: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(__dirname, "map-races-snapshot.json"), "utf8"));

// validatePoll needs to know which races exist. Reading it from the map's own current
// RACES object is the real, live version of "the same race list the map renders from" —
// exactly what validation/validatePoll.ts's own comment says a production wiring should do.
const raceExists: RaceExistsFn = (raceId, geographicId) =>
  raceId === "senate_2026" && geographicId != null && geographicId in mapRaces;

// ---- Store: the map's own current data, converted to Poll shape, is what we dedupe against ----
// Emerson's official display name in the map is "Emerson College" (not the whitelist's full
// "Emerson College Polling") — this is the one place we need that mapping, purely so dedupe can
// recognize the map's existing Emerson rows as Emerson's.
const MAP_DISPLAY_NAME_TO_POLLSTER_ID: Record<string, string> = { "Emerson College": "emerson" };

function mapRowToPoll(row: MapPollRow, geographicId: string): Poll | null {
  const pollsterId = MAP_DISPLAY_NAME_TO_POLLSTER_ID[row.pollster];
  if (!pollsterId) return null; // only need Emerson rows recognized for this pass's dedup
  return {
    pollId: `map_${pollsterId}_${geographicId}_${row.date}`,
    pollsterId,
    sourceUrl: row.src,
    race: { raceId: "senate_2026", geographicId, chamber: "senate" },
    fieldStart: null,
    fieldEnd: row.date, // the map's single "date" field is consistently the field-END date
    publishedAt: null,
    sampleSize: row.n,
    population: (row.pop as Poll["population"]) ?? "unknown",
    marginOfError: row.moe,
    candidates: [], // not needed for isSamePoll (pollster+race+geo+date only)
    ingestedAt: "unknown",
    ingestionMethod: "source_page_adapter",
  };
}

class MapBackedPollStore implements PollStore {
  saved: Poll[] = [];
  async getPollsForRace(raceId: RaceId, geographicId: string | null): Promise<Poll[]> {
    if (!geographicId) return [];
    const rows = mapPolls[geographicId] ?? [];
    return rows.map(r => mapRowToPoll(r, geographicId)).filter((p): p is Poll => p !== null);
  }
  async savePoll(poll: Poll) { this.saved.push(poll); }
  async logFailure(f: IngestionRunResult["failures"][number]) { console.log("FAILURE:", JSON.stringify(f)); }
}

// ---- Convert an accepted, validated Poll back into the map's row shape ----
function pollToMapRow(poll: Poll): MapPollRow {
  const dem = poll.candidates.find(c => c.party === "D");
  const rep = poll.candidates.find(c => c.party === "R");
  if (!dem || !rep) throw new Error("expected one D and one R candidate");
  const demSurname = dem.name.trim().split(/\s+/).at(-1);
  const repSurname = rep.name.trim().split(/\s+/).at(-1);
  return {
    pollster: "Emerson College", // matches the map's existing short-form convention
    date: poll.fieldEnd ?? poll.fieldStart ?? "unknown",
    n: poll.sampleSize,
    pop: poll.population === "unknown" ? null : poll.population,
    moe: poll.marginOfError,
    dem: dem.share,
    rep: rep.share,
    cand: `${demSurname}/${repSurname}`,
    src: poll.sourceUrl, // the real Emerson article, not the shared generic race hub link
    // houseLeanD intentionally omitted: config/pollsters.ts leaves Emerson's historicalLeanD
    // undefined ("left undefined everywhere else rather than guessed") — the map's existing
    // Emerson rows carry houseLeanD:1.8 anyway; left untouched below rather than guessed at,
    // see the run summary for why this wasn't silently resolved either way.
  };
}

async function main() {
  const store = new MapBackedPollStore();
  const races: Array<{ raceId: RaceId; geographicId: string | null }> = Object.keys(LIVE_PAGES).map(st => ({ raceId: "senate_2026", geographicId: st }));

  const updates: Record<string, MapPollRow> = {};
  for (const race of races) {
    const result = await ingestOne(liveEmersonAdapter, race, store, raceExists);
    console.log(`\n=== ${race.geographicId} ===`);
    console.log(JSON.stringify(result, null, 2));
    if (result.accepted > 0) {
      const newest = store.saved[store.saved.length - 1];
      updates[race.geographicId!] = pollToMapRow(newest);
    } else if (result.duplicates > 0) {
      console.log(`-> Already present in the map's current data for ${race.geographicId}; treating as an in-place refresh, not a new poll.`);
      // Even a "duplicate" per pollster+race+date identity can carry richer fields than the
      // hand-typed version (e.g. a real MOE where the map has null) — re-run the parse and
      // format it, so the map gets the fuller record while dedup logic still governs identity.
      const rawList = await liveEmersonAdapter.fetchLatestPolls(race);
      const raw = rawList[0];
      const validated = validatePoll(raw, raceExists);
      if (validated.ok) {
        const poll: Poll = { ...raw, pollId: "refresh", ingestedAt: new Date().toISOString(), ingestionMethod: "source_page_adapter" };
        updates[race.geographicId!] = pollToMapRow(poll);
      }
    }
  }

  fs.writeFileSync(path.join(__dirname, "map-row-updates.json"), JSON.stringify(updates, null, 2));
  console.log("\n=== Row updates to apply to the map ===");
  console.log(JSON.stringify(updates, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
