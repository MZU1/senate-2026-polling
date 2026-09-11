import type { RawPollRecord, RaceId } from "../types/poll";

/**
 * Every pollster connector implements this. Adding a new pollster means writing one of
 * these + registering it in adapters/index.ts and config/pollsters.ts — nothing in the
 * map/UI or ingestion pipeline changes.
 *
 * fetchLatestPolls does its own network I/O (HTTP GET, whatever) and returns whatever it
 * found for the given race — an EMPTY array if there's nothing new, never a thrown error
 * for "no results" (throw only for genuine failures: network error, unparseable response).
 */
export interface PollAdapter {
  pollsterId: string;
  fetchLatestPolls(race: { raceId: RaceId; geographicId: string | null }): Promise<RawPollRecord[]>;
}

/** Thrown by adapters on genuine failure (network, parse, unexpected shape) — caught by the
 *  ingestion pipeline and logged as an IngestionFailure, never allowed to produce partial/
 *  fabricated data. */
export class AdapterError extends Error {
  constructor(public pollsterId: string, message: string, public cause?: unknown) {
    super(message);
    this.name = "AdapterError";
  }
}
