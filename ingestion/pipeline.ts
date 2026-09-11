import type { Poll, RawPollRecord, IngestionRunResult, RaceId } from "../types/poll";
import { POLLSTERS, isApproved } from "../config/pollsters";
import { validatePoll, type RaceExistsFn } from "../validation/validatePoll";
import { isDuplicateOfExisting } from "../validation/dedupe";
import { computePollId } from "../validation/dedupe";
import type { PollAdapter } from "../adapters/base";
import { AdapterError } from "../adapters/base";

/** Storage is an interface, not a concrete DB, per "keep ingestion logic separate from
 *  rendering" — swap InMemoryPollStore for a real Postgres-backed one (see db/schema.sql)
 *  without touching anything else in this file. */
export interface PollStore {
  getPollsForRace(raceId: RaceId, geographicId: string | null): Promise<Poll[]>;
  savePoll(poll: Poll): Promise<void>;
  logFailure(failure: IngestionRunResult["failures"][number]): Promise<void>;
}

export class InMemoryPollStore implements PollStore {
  private polls: Poll[] = [];
  private failures: IngestionRunResult["failures"] = [];
  async getPollsForRace(raceId: RaceId, geographicId: string | null) {
    return this.polls.filter(p => p.race.raceId === raceId && (p.race.geographicId ?? null) === (geographicId ?? null));
  }
  async savePoll(poll: Poll) { this.polls.push(poll); }
  async logFailure(f: IngestionRunResult["failures"][number]) { this.failures.push(f); }
  all() { return this.polls; }
  allFailures() { return this.failures; }
}

/**
 * Runs one pollster's adapter for one race and reconciles the result against the store.
 * This is the exact flow from the spec: pollster -> adapter -> validation -> normalized
 * store. Polling-average recalculation is the store/consumer's job, not this function's —
 * see polling-average/weighting.ts, which reads whatever's in the store on demand.
 */
export async function ingestOne(
  adapter: PollAdapter,
  race: { raceId: RaceId; geographicId: string | null },
  store: PollStore,
  raceExists: RaceExistsFn
): Promise<IngestionRunResult> {
  const runAt = new Date().toISOString();
  const result: IngestionRunResult = { pollsterId: adapter.pollsterId, raceId: race.raceId, runAt, fetched: 0, accepted: 0, duplicates: 0, rejected: 0, failures: [] };

  if (!isApproved(adapter.pollsterId)) {
    result.failures.push({ pollsterId: adapter.pollsterId, reason: "pollster_not_whitelisted", occurredAt: runAt });
    return result;
  }

  let raw: RawPollRecord[];
  try {
    raw = await adapter.fetchLatestPolls(race);
  } catch (err) {
    const failure = {
      pollsterId: adapter.pollsterId,
      reason: err instanceof AdapterError ? "adapter_error" : "unexpected_error",
      detail: err instanceof Error ? err.message : String(err),
      occurredAt: runAt,
    };
    result.failures.push(failure);
    await store.logFailure(failure);
    return result;
  }
  result.fetched = raw.length;

  const existing = await store.getPollsForRace(race.raceId, race.geographicId);

  for (const rec of raw) {
    const validation = validatePoll(rec, raceExists);
    if (!validation.ok) {
      result.rejected++;
      result.failures.push(validation.failure!);
      await store.logFailure(validation.failure!);
      continue;
    }
    const dup = isDuplicateOfExisting(rec, existing);
    if (dup) { result.duplicates++; continue; }

    const poll: Poll = {
      ...rec,
      pollId: computePollId(rec),
      ingestedAt: new Date().toISOString(),
      ingestionMethod: POLLSTERS.find(p => p.id === rec.pollsterId)?.ingestionMethod ?? "manual",
    };
    await store.savePoll(poll);
    existing.push(poll); // so later records in the same batch also dedupe against it
    result.accepted++;
  }

  return result;
}

/** Runs every approved, adapter-backed pollster against every race supplied. Pollsters with
 *  no adapterId (ingestionMethod: "manual") are skipped here — they're not a pipeline failure,
 *  they're an honest "not automated yet," logged once for visibility. */
export async function ingestAll(
  adapters: Record<string, PollAdapter>,
  races: Array<{ raceId: RaceId; geographicId: string | null }>,
  store: PollStore,
  raceExists: RaceExistsFn
): Promise<IngestionRunResult[]> {
  const results: IngestionRunResult[] = [];
  for (const pollster of POLLSTERS.filter(p => p.approved)) {
    const adapter = pollster.adapterId ? adapters[pollster.adapterId] : undefined;
    if (!adapter) continue; // manual-only pollster; nothing to run automatically
    for (const race of races) {
      results.push(await ingestOne(adapter, race, store, raceExists));
    }
  }
  return results;
}
