import type { RawPollRecord, IngestionFailure } from "../types/poll";
import { isApproved, isOfficialDomain } from "../config/pollsters";

export interface ValidationResult {
  ok: boolean;
  failure?: IngestionFailure;
}

/** Known race registry check. In production this reads the live race list (races.ts / the
 *  same data the map renders from) — kept as an injected function so this module has no
 *  dependency on the Senate-2026-specific race data, per "provider independence." */
export type RaceExistsFn = (raceId: string, geographicId: string | null) => boolean;

export function validatePoll(raw: RawPollRecord, raceExists: RaceExistsFn): ValidationResult {
  const fail = (reason: string, detail?: string): ValidationResult => ({
    ok: false,
    failure: { pollsterId: raw.pollsterId, sourceUrl: raw.sourceUrl, reason, detail, occurredAt: new Date().toISOString() },
  });

  if (!raw.pollsterId) return fail("missing_pollster_id");
  if (!isApproved(raw.pollsterId)) return fail("pollster_not_whitelisted", raw.pollsterId);

  if (!raw.sourceUrl) return fail("missing_source_url");
  if (!isOfficialDomain(raw.pollsterId, raw.sourceUrl)) {
    return fail("source_not_official_domain", raw.sourceUrl);
  }

  if (!raw.race?.raceId) return fail("missing_race_id");
  if (!raceExists(raw.race.raceId, raw.race.geographicId)) {
    return fail("unknown_race", `${raw.race.raceId} / ${raw.race.geographicId ?? "national"}`);
  }

  if (!Array.isArray(raw.candidates) || raw.candidates.length < 2) {
    return fail("insufficient_candidates", `found ${raw.candidates?.length ?? 0}`);
  }
  for (const c of raw.candidates) {
    if (!c.name || typeof c.share !== "number" || Number.isNaN(c.share)) {
      return fail("malformed_candidate", JSON.stringify(c));
    }
    if (c.share < 0 || c.share > 100) return fail("candidate_share_out_of_range", `${c.name}: ${c.share}`);
  }

  // Shares (+ undecided/other, when present) shouldn't wildly exceed 100 — a generous band
  // tolerates rounding across many outlets, but catches genuinely malformed extractions.
  const total = raw.candidates.reduce((s, c) => s + c.share, 0) + (raw.undecidedShare ?? 0) + (raw.otherShare ?? 0);
  if (total < 80 || total > 115) return fail("shares_dont_sum_reasonably", `total=${total}`);

  if (raw.sampleSize != null && (raw.sampleSize < 50 || raw.sampleSize > 100000)) {
    return fail("implausible_sample_size", String(raw.sampleSize));
  }

  return { ok: true };
}
