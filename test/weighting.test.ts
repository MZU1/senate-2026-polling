import fs from "fs";
import { weightedPollingAverage, DEFAULT_WEIGHTING } from "../polling-average/weighting";
import type { Poll } from "../types/poll";

const polls: Poll[] = JSON.parse(fs.readFileSync(new URL("./fixtures/tx-polls-normalized.json", import.meta.url), "utf8"));
const referenceDate = new Date("2026-08-21T12:00:00Z");

const defaultResult = weightedPollingAverage(polls, DEFAULT_WEIGHTING, referenceDate)!;
console.log("Default (recency-only) margin:", defaultResult.margin.toFixed(2), `(D${defaultResult.margin >= 0 ? "+" : ""}${defaultResult.margin.toFixed(1)})`);
console.log("Contributions:");
for (const c of defaultResult.contributions) {
  console.log(`  ${c.pollster.padEnd(24)} ${c.date}  raw=${c.rawMargin.toFixed(1).padStart(5)}  weight=${(c.weightShare*100).toFixed(1)}%`);
}

const withHouseLean = weightedPollingAverage(polls, { ...DEFAULT_WEIGHTING, houseLeanAdjustment: true }, referenceDate)!;
console.log("\nWith house-lean adjustment margin:", withHouseLean.margin.toFixed(2));

const withSampleWeight = weightedPollingAverage(polls, { ...DEFAULT_WEIGHTING, sampleSizeWeight: true }, referenceDate)!;
console.log("With sample-size weighting margin:", withSampleWeight.margin.toFixed(2));

const weightSum = defaultResult.contributions.reduce((s, c) => s + c.weightShare, 0);

const checks: Array<[string, boolean]> = [
  ["returns a result for 6 real polls", defaultResult.pollCount === 6],
  ["weight shares sum to ~1.0", Math.abs(weightSum - 1) < 1e-9],
  ["most recent poll (Aug 10 Emerson) has the highest weight share", defaultResult.contributions[0].date === "2026-08-10"],
  ["house-lean adjustment shifts margin toward R (pollsters here lean D historically)", withHouseLean.margin < defaultResult.margin],
  ["sample-size weighting changes the result from default", withSampleWeight.margin !== defaultResult.margin],
  ["margin is a plausible number, not NaN/Infinity", Number.isFinite(defaultResult.margin)],
];

let allPass = true;
for (const [label, pass] of checks) {
  console.log(pass ? "PASS" : "FAIL", "-", label);
  if (!pass) allPass = false;
}
if (!allPass) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
console.log("\nAll checks passed.");
