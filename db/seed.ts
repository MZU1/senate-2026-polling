// One-time (idempotent) seed: pollsters table from config/pollsters.ts (unmodified, the
// same whitelist validatePoll/isOfficialDomain already enforce), races table from the map's
// own RACES data — so "which races exist" has one source of truth instead of being
// duplicated/guessed here. Run with: DATABASE_URL=... npx tsx db/seed.ts <path-to-map-file>
import fs from "fs";
import { getPool, closePool } from "./connection";
import { POLLSTERS } from "../config/pollsters";

const SENATE_ELECTION_DAY_2026 = "2026-11-03"; // first Tue after first Mon in Nov, 2026

async function main() {
  const mapPath = process.argv[2];
  if (!mapPath) throw new Error("Usage: seed.ts <path-to-map-tsx>");
  const content = fs.readFileSync(mapPath, "utf8");
  const m = content.match(/^const RACES = (\{.*\});/m);
  if (!m) throw new Error("Could not find RACES in the map file");
  const races: Record<string, unknown> = JSON.parse(m[1]);

  const pool = getPool();

  for (const p of POLLSTERS) {
    await pool.query(
      `INSERT INTO pollsters (id, name, approved, official_domains, ingestion_method, adapter_id, quality_notes, historical_lean_d, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, approved=EXCLUDED.approved, official_domains=EXCLUDED.official_domains,
         ingestion_method=EXCLUDED.ingestion_method, adapter_id=EXCLUDED.adapter_id, quality_notes=EXCLUDED.quality_notes,
         historical_lean_d=EXCLUDED.historical_lean_d, source_url=EXCLUDED.source_url`,
      [p.id, p.name, p.approved, p.officialDomains, p.ingestionMethod, p.adapterId, p.qualityNotes ?? null, p.historicalLeanD ?? null, p.sourceUrl]
    );
  }
  console.log(`Seeded ${POLLSTERS.length} pollsters.`);

  let raceCount = 0;
  for (const geographicId of Object.keys(races)) {
    await pool.query(
      `INSERT INTO races (race_id, geographic_id, chamber, election_day)
       VALUES ($1,$2,$3,$4) ON CONFLICT (race_id, geographic_id) DO NOTHING`,
      ["senate_2026", geographicId, "senate", SENATE_ELECTION_DAY_2026]
    );
    raceCount++;
  }
  console.log(`Seeded ${raceCount} races (senate_2026).`);

  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
