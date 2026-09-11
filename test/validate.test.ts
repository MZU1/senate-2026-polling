import { validatePoll } from "../validation/validatePoll";
import type { RawPollRecord } from "../types/poll";

const raceExists = (raceId: string, geo: string | null) => raceId === "senate_2026" && geo === "IA";

const goodPoll: RawPollRecord = {
  pollsterId: "emerson",
  sourceUrl: "https://emersoncollegepolling.com/iowa-2026-poll/",
  race: { raceId: "senate_2026", geographicId: "IA", chamber: "senate" },
  fieldStart: "2026-08-02", fieldEnd: "2026-08-04", publishedAt: "2026-08-06T10:01:56+00:00",
  sampleSize: 712, population: "LV", marginOfError: 3.7,
  candidates: [{ name: "Ashley Hinson", party: "R", share: 48 }, { name: "Josh Turek", party: "D", share: 45 }],
  undecidedShare: 6, otherShare: null,
};

const cases: Array<[string, RawPollRecord, boolean]> = [
  ["valid poll passes", goodPoll, true],
  ["unapproved pollster rejected", { ...goodPoll, pollsterId: "some_random_blog" }, false],
  ["wrong domain rejected (spoofed source)", { ...goodPoll, sourceUrl: "https://totally-not-emerson.example.com/poll" }, false],
  ["unknown race rejected", { ...goodPoll, race: { raceId: "senate_2026", geographicId: "ZZ", chamber: "senate" } }, false],
  ["single candidate rejected", { ...goodPoll, candidates: [goodPoll.candidates[0]] }, false],
  ["share out of range rejected", { ...goodPoll, candidates: [{ name: "A", party: "R", share: 140 }, { name: "B", party: "D", share: 45 }] }, false],
  ["shares don't sum reasonably (garbled extraction)", { ...goodPoll, candidates: [{ name: "A", party: "R", share: 5 }, { name: "B", party: "D", share: 3 }] }, false],
  ["implausible sample size rejected", { ...goodPoll, sampleSize: 3 }, false],
];

let allPass = true;
for (const [label, poll, expectOk] of cases) {
  const result = validatePoll(poll, raceExists);
  const pass = result.ok === expectOk;
  console.log(pass ? "PASS" : "FAIL", "-", label, result.ok ? "" : `(rejected: ${result.failure?.reason})`);
  if (!pass) allPass = false;
}
if (!allPass) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
console.log("\nAll checks passed.");
