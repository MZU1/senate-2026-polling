import fs from "fs";
import { parseEmersonPost } from "../adapters/emerson";

const text = fs.readFileSync(new URL("./fixtures/emerson-iowa-2026.txt", import.meta.url), "utf8");

const result = parseEmersonPost(text, "https://emersoncollegepolling.com/iowa-2026-poll/", { raceId: "senate_2026", geographicId: "IA" });

console.log(JSON.stringify(result, null, 2));

// Assertions against known-correct values (verified by reading the real page myself)
const checks: Array<[string, boolean]> = [
  ["publishedAt captured", result.publishedAt === "2026-08-06T10:01:56+00:00"],
  ["fieldStart correct", result.fieldStart === "2026-08-02"],
  ["fieldEnd correct", result.fieldEnd === "2026-08-04"],
  ["sampleSize correct", result.sampleSize === 712],
  ["population LV", result.population === "LV"],
  ["marginOfError correct", result.marginOfError === 3.7],
  ["2 candidates found", result.candidates.length === 2],
  ["Hinson R 48", result.candidates.some(c => c.name === "Ashley Hinson" && c.party === "R" && c.share === 48)],
  ["Turek D 45", result.candidates.some(c => c.name === "Josh Turek" && c.party === "D" && c.share === 45)],
  ["undecided 6", result.undecidedShare === 6],
  ["sponsor Nexstar", result.sponsor === "Nexstar Media"],
];

let allPass = true;
for (const [label, pass] of checks) {
  console.log(pass ? "PASS" : "FAIL", "-", label);
  if (!pass) allPass = false;
}

// Second real fixture: Texas phrases the same kind of sentence differently ("...the U.S. Senate
// race in a dead heat: 47% support..." vs Iowa's "...for U.S. Senate, 48% support..."). This is
// what motivated generalizing extractSenateRace from a fixed prefix to an anchor-window search —
// proves the change actually generalizes rather than just re-fitting Iowa.
const txText = fs.readFileSync(new URL("./fixtures/emerson-texas-2026.txt", import.meta.url), "utf8");
const txResult = parseEmersonPost(txText, "https://emersoncollegepolling.com/texas-2026-poll-paxton-and-talarico/", { raceId: "senate_2026", geographicId: "TX" });
console.log("\n" + JSON.stringify(txResult, null, 2));

const txChecks: Array<[string, boolean]> = [
  ["TX publishedAt captured", txResult.publishedAt === "2026-08-13T10:03:36+00:00"],
  ["TX fieldStart correct", txResult.fieldStart === "2026-08-09"],
  ["TX fieldEnd correct", txResult.fieldEnd === "2026-08-10"],
  ["TX sampleSize correct", txResult.sampleSize === 1000],
  ["TX population LV", txResult.population === "LV"],
  ["TX marginOfError correct", txResult.marginOfError === 3],
  ["TX 2 candidates found", txResult.candidates.length === 2],
  ["TX Paxton R 47", txResult.candidates.some(c => c.name === "Ken Paxton" && c.party === "R" && c.share === 47)],
  ["TX Talarico D 46", txResult.candidates.some(c => c.name === "James Talarico" && c.party === "D" && c.share === 46)],
  ["TX undecided 5 (not the Governor race's 4)", txResult.undecidedShare === 5],
  ["TX sponsor Nexstar", txResult.sponsor === "Nexstar Media"],
];
for (const [label, pass] of txChecks) {
  console.log(pass ? "PASS" : "FAIL", "-", label);
  if (!pass) allPass = false;
}

if (!allPass) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
console.log("\nAll checks passed.");
