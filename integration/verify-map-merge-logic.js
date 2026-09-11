// Mirrors the map component's fetch+merge logic exactly (same endpoint, same merge rule) to
// verify it produces correct results against the real running API before trusting a browser to.
const fs = require("fs");

async function main() {
  const content = fs.readFileSync("/home/claude/work/site/3senate-2026-magic-wall.tsx", "utf8");
  const m = content.match(/^const STATIC_POLLS = (\{.*\});/m);
  const staticPolls = JSON.parse(m[1]);

  const res = await fetch("http://localhost:4001/api/polls/emerson?raceId=senate_2026");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const liveEmersonPolls = data.states;

  // Identical merge rule to the component's useMemo
  const mergedPolls = {};
  for (const st of Object.keys(staticPolls)) {
    const liveRows = liveEmersonPolls[st];
    if (liveRows && liveRows.length) {
      const staticNonEmerson = staticPolls[st].filter(p => p.pollster !== "Emerson College");
      mergedPolls[st] = [...liveRows, ...staticNonEmerson];
    } else {
      mergedPolls[st] = staticPolls[st];
    }
  }

  console.log("=== IA (should be live-sourced now) ===");
  console.log(JSON.stringify(mergedPolls.IA, null, 2));
  console.log("\n=== TX (should be live-sourced now) ===");
  console.log(JSON.stringify(mergedPolls.TX, null, 2));
  console.log("\n=== NC (no live Emerson data yet — must be byte-identical to static) ===");
  const ncUnchanged = JSON.stringify(mergedPolls.NC) === JSON.stringify(staticPolls.NC);
  console.log("NC unchanged:", ncUnchanged, "| poll count:", mergedPolls.NC.length);

  const iaIsLive = mergedPolls.IA.some(p => p.pollster === "Emerson College" && p.src.includes("emersoncollegepolling.com"));
  const txIsLive = mergedPolls.TX.some(p => p.pollster === "Emerson College" && p.src.includes("emersoncollegepolling.com"));
  const iaOtherPollstersIntact = mergedPolls.IA.filter(p => p.pollster !== "Emerson College").length === staticPolls.IA.filter(p => p.pollster !== "Emerson College").length;

  console.log("\n=== Checks ===");
  console.log(iaIsLive ? "PASS" : "FAIL", "- IA Emerson row is live-sourced");
  console.log(txIsLive ? "PASS" : "FAIL", "- TX Emerson row is live-sourced");
  console.log(iaOtherPollstersIntact ? "PASS" : "FAIL", "- IA's other pollsters (NYT/Siena, Fox News) untouched");
  console.log(ncUnchanged ? "PASS" : "FAIL", "- NC (no live data) is byte-identical to static baseline");

  if (!(iaIsLive && txIsLive && iaOtherPollstersIntact && ncUnchanged)) process.exit(1);
  console.log("\nAll checks passed — the component's merge logic is correct against real live data.");
}

main().catch(e => { console.error(e); process.exit(1); });
