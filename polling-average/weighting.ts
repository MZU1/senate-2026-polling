import type { Poll } from "../types/poll";
import { getPollster } from "../config/pollsters";

/**
 * Every factor here is OFF by default except recency (which the map/UI has shown since the
 * first version of this project and users already understand). Turning on qualityWeight or
 * sampleSizeWeight changes the number people see — that's a deliberate choice the caller makes
 * explicitly, never a silent default. See README "Polling average" for why.
 */
export interface WeightingConfig {
  /** Exponential recency decay half-life, in days. Same default as the map has used throughout. */
  recencyHalfLifeDays: number;
  /** Multiply by a poll's sample size (relative to a reference size) when true. */
  sampleSizeWeight: boolean;
  referenceSampleSize: number;
  /** Multiply by (1 / historical average error) when the pollster has a known track record. */
  qualityWeight: boolean;
  /** Subtract each pollster's known historical D-lean from its margin before averaging. */
  houseLeanAdjustment: boolean;
}

export const DEFAULT_WEIGHTING: WeightingConfig = {
  recencyHalfLifeDays: 21,
  sampleSizeWeight: false,
  referenceSampleSize: 800,
  qualityWeight: false,
  houseLeanAdjustment: false,
};

export interface WeightedAverageResult {
  margin: number; // D-R points
  pollCount: number;
  totalWeight: number;
  respondents: number | null;
  latestDate: string;
  /** Per-poll breakdown — always returned so callers/UI can show "why this number," never a
   *  black box. */
  contributions: Array<{ pollId: string; pollster: string; date: string; rawMargin: number; adjustedMargin: number; weight: number; weightShare: number }>;
}

export function weightedPollingAverage(polls: Poll[], config: WeightingConfig = DEFAULT_WEIGHTING, referenceDate: Date = new Date()): WeightedAverageResult | null {
  if (polls.length === 0) return null;

  const raw = polls.map(p => {
    const date = new Date(p.fieldEnd ?? p.fieldStart ?? p.publishedAt ?? referenceDate.toISOString());
    const daysOld = Math.max(0, (referenceDate.getTime() - date.getTime()) / 86400000);
    let weight = Math.pow(0.5, daysOld / config.recencyHalfLifeDays);

    if (config.sampleSizeWeight && p.sampleSize) {
      weight *= Math.sqrt(p.sampleSize / config.referenceSampleSize);
    }
    const pollster = getPollster(p.pollsterId);
    if (config.qualityWeight && pollster) {
      // Lower historical error -> higher weight. Pollsters without a recorded error stay at 1x
      // (no penalty for missing data — see README on not fabricating quality scores).
      const err = pollster.qualityNotes?.match(/average error ~?([\d.]+)pts/)?.[1];
      if (err) weight *= 1 / Math.max(0.5, parseFloat(err));
    }

    const [c1, c2] = pickTwoWayCandidates(p);
    let rawMargin = c1 && c2 ? signedMargin(c1, c2) : 0;
    let adjustedMargin = rawMargin;
    if (config.houseLeanAdjustment && pollster?.historicalLeanD != null) {
      adjustedMargin = rawMargin - pollster.historicalLeanD;
    }

    return { poll: p, date, weight, rawMargin, adjustedMargin };
  });

  const totalWeight = raw.reduce((s, r) => s + r.weight, 0);
  const margin = raw.reduce((s, r) => s + r.weight * r.adjustedMargin, 0) / totalWeight;
  const respondents = polls.every(p => p.sampleSize != null)
    ? polls.reduce((s, p) => s + (p.sampleSize ?? 0), 0)
    : null;

  return {
    margin,
    pollCount: polls.length,
    totalWeight,
    respondents,
    latestDate: raw.map(r => r.poll.fieldEnd ?? r.poll.fieldStart ?? "").sort().at(-1) ?? "",
    contributions: raw
      .sort((a, b) => b.weight - a.weight)
      .map(r => ({
        pollId: r.poll.pollId, pollster: r.poll.pollsterId, date: r.poll.fieldEnd ?? r.poll.fieldStart ?? "",
        rawMargin: r.rawMargin, adjustedMargin: r.adjustedMargin, weight: r.weight, weightShare: r.weight / totalWeight,
      })),
  };
}

/** Picks the two largest-share candidates as the "D vs R" pair for a signed margin. Returns
 *  nulls (never a guess) if the poll isn't cleanly two-party. */
function pickTwoWayCandidates(p: Poll) {
  const d = p.candidates.find(c => c.party === "D");
  const r = p.candidates.find(c => c.party === "R");
  return [d, r] as const;
}
function signedMargin(d: { party: string; share: number }, r: { party: string; share: number }): number {
  return d.share - r.share; // positive = D ahead
}
