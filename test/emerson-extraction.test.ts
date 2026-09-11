// Tests adapters/emerson.ts's extractArticleText (Readability-based HTML->text step) against
// a realistic WordPress-style page — nav, cookie banner, sidebar "Related Polls" (deliberately
// containing a DIFFERENT state's numbers, to catch any cross-contamination), comments, footer.
//
// This sandbox's network egress can't reach emersoncollegepolling.com to fetch a real raw-HTML
// sample (confirmed: fetch() returns 403 host_not_allowed from the sandbox's own egress proxy,
// not from Emerson — see README). So the HTML *structure* here is a realistic synthetic
// approximation of a WordPress post page; the article *text* embedded inside it is the same
// real, live-fetched Iowa content already verified in test/emerson.test.ts. This test exercises
// the extraction code path, not new poll data.
import fs from "fs";
import { extractArticleText } from "../adapters/emerson";
import { parseEmersonPost } from "../adapters/emerson";

const html = fs.readFileSync(new URL("./fixtures/emerson-iowa-2026-synthetic-page.html", import.meta.url), "utf8");
const extracted = extractArticleText(html, "https://emersoncollegepolling.com/iowa-2026-poll/");

console.log("--- extracted length ---");
console.log(extracted.length, "chars");

const checks: Array<[string, boolean]> = [
  ["Contains the real Senate sentence", extracted.includes("48% support Republican Ashley Hinson, while 45% support Democrat Josh Turek")],
  ["Contains the methodology paragraph", extracted.includes("conducted August 2-4, 2026")],
  ["Does NOT pull in sidebar's Texas numbers (no cross-contamination)", !extracted.includes("47% support Republican Ken Paxton")],
  ["Does NOT include nav menu text", !extracted.includes("Subscribe for poll alerts") && !extracted.includes("Sign up for poll alerts")],
  ["Does NOT include comment thread", !extracted.includes("PollWatcher22")],
  ["Does NOT include cookie banner", !extracted.includes("We use cookies")],
];

let allPass = true;
for (const [label, pass] of checks) {
  console.log(pass ? "PASS" : "FAIL", "-", label);
  if (!pass) allPass = false;
}

// The real end-to-end proof: feed the EXTRACTED text (not the hand-trimmed fixture) through
// the actual parser and confirm it produces the identical, already-verified result.
const parsed = parseEmersonPost(extracted, "https://emersoncollegepolling.com/iowa-2026-poll/", { raceId: "senate_2026", geographicId: "IA" });
const parseChecks: Array<[string, boolean]> = [
  ["Parsed from extracted HTML: 2 candidates", parsed.candidates.length === 2],
  ["Parsed from extracted HTML: Hinson R 48", parsed.candidates.some(c => c.name === "Ashley Hinson" && c.party === "R" && c.share === 48)],
  ["Parsed from extracted HTML: Turek D 45", parsed.candidates.some(c => c.name === "Josh Turek" && c.party === "D" && c.share === 45)],
  ["Parsed from extracted HTML: sampleSize 712", parsed.sampleSize === 712],
  ["Parsed from extracted HTML: marginOfError 3.7", parsed.marginOfError === 3.7],
];
for (const [label, pass] of parseChecks) {
  console.log(pass ? "PASS" : "FAIL", "-", label);
  if (!pass) allPass = false;
}

if (!allPass) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
console.log("\nAll checks passed.");
