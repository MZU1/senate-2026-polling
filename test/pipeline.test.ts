import { ingestOne, ingestAll, InMemoryPollStore } from "../ingestion/pipeline";
import type { PollAdapter } from "../adapters/base";
import { AdapterError } from "../adapters/base";
import type { RawPollRecord } from "../types/poll";

const raceExists = (raceId: string, geo: string | null) => raceId === "senate_2026" && geo === "IA";

function makeIowaPoll(fieldEnd: string, hinson: number, turek: number): RawPollRecord {
  return {
    pollsterId: "emerson",
    sourceUrl: "https://emersoncollegepolling.com/iowa-2026-poll/",
    race: { raceId: "senate_2026", geographicId: "IA", chamber: "senate" },
    fieldStart: fieldEnd, fieldEnd, publishedAt: fieldEnd + "T10:00:00Z",
    sampleSize: 712, population: "LV", marginOfError: 3.7,
    candidates: [{ name: "Ashley Hinson", party: "R", share: hinson }, { name: "Josh Turek", party: "D", share: turek }],
    undecidedShare: 100 - hinson - turek, otherShare: null,
  };
}

async function main() {
  let allPass = true;
  const check = (label: string, pass: boolean) => { console.log(pass ? "PASS" : "FAIL", "-", label); if (!pass) allPass = false; };

  // --- Run 1: adapter returns one real-shaped poll ---
  const store = new InMemoryPollStore();
  const fakeAdapter: PollAdapter = { pollsterId: "emerson", fetchLatestPolls: async () => [makeIowaPoll("2026-08-04", 48, 45)] };
  const run1 = await ingestOne(fakeAdapter, { raceId: "senate_2026", geographicId: "IA" }, store, raceExists);
  check("run1: fetched 1", run1.fetched === 1);
  check("run1: accepted 1", run1.accepted === 1);
  check("run1: store has 1 poll", store.all().length === 1);

  // --- Run 2: same adapter, SAME poll returned again (simulates a re-run of the scheduler) ---
  const run2 = await ingestOne(fakeAdapter, { raceId: "senate_2026", geographicId: "IA" }, store, raceExists);
  check("run2: detected as duplicate, not re-saved", run2.duplicates === 1 && run2.accepted === 0);
  check("run2: store still has exactly 1 poll", store.all().length === 1);

  // --- Run 3: a genuinely NEW poll (different field date) from the same pollster ---
  const adapterWithNewPoll: PollAdapter = { pollsterId: "emerson", fetchLatestPolls: async () => [makeIowaPoll("2026-08-18", 47, 46)] };
  const run3 = await ingestOne(adapterWithNewPoll, { raceId: "senate_2026", geographicId: "IA" }, store, raceExists);
  check("run3: new poll accepted", run3.accepted === 1);
  check("run3: store now has 2 polls", store.all().length === 2);

  // --- Run 4: adapter returns a malformed record (should be rejected, not silently dropped-without-trace) ---
  const badAdapter: PollAdapter = { pollsterId: "emerson", fetchLatestPolls: async () => [{ ...makeIowaPoll("2026-08-20", 200, 45) }] };
  const run4 = await ingestOne(badAdapter, { raceId: "senate_2026", geographicId: "IA" }, store, raceExists);
  check("run4: malformed record rejected", run4.rejected === 1 && run4.accepted === 0);
  check("run4: failure logged with reason", store.allFailures().some(f => f.reason === "candidate_share_out_of_range"));

  // --- Run 5: unapproved pollster is refused before any fetch happens ---
  const rogueAdapter: PollAdapter = { pollsterId: "some_random_blog", fetchLatestPolls: async () => [makeIowaPoll("2026-08-21", 50, 45)] };
  const run5 = await ingestOne(rogueAdapter, { raceId: "senate_2026", geographicId: "IA" }, store, raceExists);
  check("run5: unapproved pollster refused", run5.failures[0]?.reason === "pollster_not_whitelisted");
  check("run5: nothing fetched/saved for it", run5.fetched === 0 && store.all().length === 2);

  // --- Run 6: adapter throws (network failure) — must be caught and logged, never crash the run ---
  const brokenAdapter: PollAdapter = { pollsterId: "emerson", fetchLatestPolls: async () => { throw new AdapterError("emerson", "simulated network timeout"); } };
  const run6 = await ingestOne(brokenAdapter, { raceId: "senate_2026", geographicId: "IA" }, store, raceExists);
  check("run6: adapter failure caught and logged, not thrown", run6.failures[0]?.reason === "adapter_error");

  // --- ingestAll: skips manual-only pollsters (no adapter registered), runs the rest ---
  const adapters = { emerson: fakeAdapter };
  const allResults = await ingestAll(adapters, [{ raceId: "senate_2026", geographicId: "IA" }], new InMemoryPollStore(), raceExists);
  check("ingestAll only ran pollsters with a registered adapter", allResults.length === 1 && allResults[0].pollsterId === "emerson");

  if (!allPass) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
  console.log("\nAll checks passed.");
}
main();
