import type { RawPollRecord, Poll } from "../types/poll";

/** Deterministic ID so re-ingesting the same poll (e.g. a re-run of the scheduler) never
 *  creates a second row — identity is a function of content, not insertion order. */
export function computePollId(raw: RawPollRecord): string {
  const candidateKey = raw.candidates
    .map(c => `${c.name.toLowerCase().trim()}:${c.share}`)
    .sort()
    .join("|");
  const parts = [
    raw.pollsterId,
    raw.race.raceId,
    raw.race.geographicId ?? "national",
    raw.fieldEnd ?? raw.fieldStart ?? "unknown-date",
    candidateKey,
  ];
  return "poll_" + fnv1a(parts.join("::"));
}

// Small, dependency-free deterministic hash (FNV-1a). Not cryptographic — doesn't need to be,
// this is a dedup key, not a security boundary.
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Two raw records are the "same poll" if they share a pollster, race, and field-end date.
 * Deliberately does NOT require the reported numbers to already match — the real-world case
 * that motivated this (PollingSource listing "High Point University" for one NC release as a
 * 660-LV topline, an 800-RV topline, AND a no-sample-given variant matching the LV numbers) is
 * exactly one survey reported multiple ways by an aggregator, and pollsters legitimately publish
 * both an RV and LV cut of a single fielding period. Collapsing to one record per (pollster,
 * race, field date) and letting pickCanonical choose the best cut (LV preferred) avoids double-
 * counting that one survey as two independent polls in an average.
 *
 * Field date is required to match exactly (not "close enough") — two genuinely different
 * releases a week apart from the same pollster on the same race must NOT collapse into one.
 */
export function isSamePoll(a: RawPollRecord, b: RawPollRecord): boolean {
  if (a.pollsterId !== b.pollsterId) return false;
  if (a.race.raceId !== b.race.raceId) return false;
  if ((a.race.geographicId ?? null) !== (b.race.geographicId ?? null)) return false;
  const aDate = a.fieldEnd ?? a.fieldStart, bDate = b.fieldEnd ?? b.fieldStart;
  return aDate !== null && aDate === bDate;
}

export interface DedupeResult {
  kept: RawPollRecord[];
  duplicatesDropped: number;
  /** For each kept record, which (if any) raw variants were folded into it — audit trail. */
  mergedFrom: Map<RawPollRecord, RawPollRecord[]>;
  /** Merged groups whose variants reported meaningfully different numbers (e.g. an LV cut vs.
   *  an RV cut of the same fielding period, as PollingSource shows for High Point/NC) — not an
   *  error, but worth surfacing rather than silently picking one and discarding the spread. */
  discrepancies: Array<{ canonical: RawPollRecord; variants: RawPollRecord[]; maxSpread: number }>;
}

/** Prefers, in order: a record with a non-null sampleSize+population (LV over RV over unknown),
 *  then the one with more complete metadata (moe present), then simply the first seen — never
 *  averages or invents a merged number between variants. */
function pickCanonical(group: RawPollRecord[]): RawPollRecord {
  const score = (r: RawPollRecord) => {
    let s = 0;
    if (r.sampleSize != null) s += 2;
    if (r.population === "LV") s += 2;
    else if (r.population === "RV") s += 1;
    if (r.marginOfError != null) s += 1;
    if (r.sponsor) s += 1; // more attribution info is better, not worse
    return s;
  };
  return group.slice().sort((a, b) => score(b) - score(a))[0];
}

export function dedupe(records: RawPollRecord[]): DedupeResult {
  const groups: RawPollRecord[][] = [];
  for (const r of records) {
    const group = groups.find(g => isSamePoll(g[0], r));
    if (group) group.push(r); else groups.push([r]);
  }
  const kept: RawPollRecord[] = [];
  const mergedFrom = new Map<RawPollRecord, RawPollRecord[]>();
  const discrepancies: DedupeResult["discrepancies"] = [];
  let duplicatesDropped = 0;
  for (const g of groups) {
    const canonical = pickCanonical(g);
    kept.push(canonical);
    if (g.length > 1) {
      mergedFrom.set(canonical, g);
      duplicatesDropped += g.length - 1;
      const spread = maxCandidateSpread(g);
      if (spread > 3) discrepancies.push({ canonical, variants: g, maxSpread: spread });
    }
  }
  return { kept, duplicatesDropped, mergedFrom, discrepancies };
}

/** Largest difference, across all variants in a merged group, in any one candidate's reported
 *  share — used only to flag discrepancies for review, never to alter what's stored. */
function maxCandidateSpread(group: RawPollRecord[]): number {
  const byName = new Map<string, number[]>();
  for (const r of group) for (const c of r.candidates) {
    const key = c.name.toLowerCase().trim();
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(c.share);
  }
  let max = 0;
  for (const shares of byName.values()) max = Math.max(max, Math.max(...shares) - Math.min(...shares));
  return max;
}

/** Checks a single new raw record against polls already in the store (not against itself in a
 *  batch — see dedupe() for that). Used by the ingestion pipeline on every incoming record. */
export function isDuplicateOfExisting(raw: RawPollRecord, existing: Poll[]): Poll | null {
  return existing.find(p => isSamePoll(raw, p)) ?? null;
}
