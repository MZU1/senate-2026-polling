import fs from "fs";
import { dedupe } from "../validation/dedupe";
import type { RawPollRecord } from "../types/poll";

const raw: RawPollRecord[] = JSON.parse(
  fs.readFileSync(new URL("./fixtures/nc-raw-with-duplicates.json", import.meta.url), "utf8")
);

console.log(`Input: ${raw.length} raw records`);
const result = dedupe(raw);
console.log(`Output: ${result.kept.length} unique polls, ${result.duplicatesDropped} duplicates dropped\n`);

for (const k of result.kept) {
  const merged = result.mergedFrom.get(k);
  console.log(`- ${k.pollsterId} (${k.fieldEnd}): n=${k.sampleSize} ${k.population}` + (merged ? `  [merged from ${merged.length} listings]` : ""));
}
if (result.discrepancies.length) {
  console.log("\nDiscrepancies flagged (merged variants disagreed by >3pts on some candidate):");
  for (const d of result.discrepancies) console.log(`- ${d.canonical.pollsterId} (${d.canonical.fieldEnd}): spread=${d.maxSpread}pts across ${d.variants.length} variants`);
}

const checks: Array<[string, boolean]> = [
  ["8 raw -> 4 unique polls", result.kept.length === 4],
  ["4 duplicates dropped", result.duplicatesDropped === 4],
  ["High Point's 3 listings merged into 1, LV cut picked (n=660)", result.kept.some(k => k.pollsterId === "high_point" && k.sampleSize === 660 && k.population === "LV") && result.kept.filter(k => k.pollsterId === "high_point").length === 1],
  ["High Point LV/RV discrepancy flagged (not silently dropped)", result.discrepancies.some(d => d.canonical.pollsterId === "high_point")],
  ["Harper's 3 listings merged into 1", result.kept.filter(k => k.pollsterId === "harper_polling").length === 1],
  ["Both distinct Change Research dates survived (Aug06 and Aug01)", result.kept.filter(k => k.pollsterId === "change_research").length === 2],
];

let allPass = true;
for (const [label, pass] of checks) {
  console.log(pass ? "PASS" : "FAIL", "-", label);
  if (!pass) allPass = false;
}
if (!allPass) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
console.log("\nAll checks passed.");
