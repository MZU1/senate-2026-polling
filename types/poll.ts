// ============================================================================
// Normalized poll/pollster/race schema.
// Every adapter, regardless of source, must produce a RawPollRecord. Validation
// promotes a RawPollRecord to a Poll (assigns pollId, verifies it, timestamps it).
// The map/UI layer only ever reads Poll[] — it never knows where a poll came from.
// ============================================================================

/** Election type + year, e.g. "senate_2026", "house_2026", "governor_2026", "president_2028".
 *  Free-form but conventionally `${officeType}_${electionYear}` so new race types/years
 *  never require touching this file or the map layer. */
export type RaceId = string;

export type Chamber = "senate" | "house" | "governor" | "president";

/** A single contested race within a RaceId's election (e.g. the NC seat in senate_2026). */
export interface RaceRef {
  raceId: RaceId;
  /** USPS state abbreviation, or for House, state+district e.g. "NC-13". Null for president. */
  geographicId: string | null;
  chamber: Chamber;
}

export type PopulationType = "LV" | "RV" | "A" | "V" | "unknown"; // likely/registered/all-adult/voters

/** How a pollster's data is actually obtained. Ordered by preference — see config/pollsters.ts. */
export type IngestionMethod =
  | "official_api"        // pollster or sponsor publishes a real API
  | "official_feed"       // RSS/JSON feed, e.g. a CMS's built-in REST endpoint
  | "source_page_adapter" // we parse the pollster's own press-release page
  | "manual";             // no automated path yet; a human enters/verifies it

export interface PollsterConfig {
  id: string;                    // stable slug, e.g. "emerson"
  name: string;                  // display name
  approved: boolean;             // whitelist gate — unapproved pollsters are never ingested
  officialDomains: string[];     // only polls whose source URL matches one of these are trusted
  ingestionMethod: IngestionMethod;
  /** Which adapters/index.ts key implements this pollster. Null if ingestionMethod is "manual". */
  adapterId: string | null;
  /** Free-text notes on quality/lean, e.g. AAPOR membership, historical house lean if known.
   *  Informational only — never silently used to alter a reported number, only to weight averages
   *  or to display alongside a poll (see polling-average/weighting.ts). */
  qualityNotes?: string;
  /** Historical D-lean in points, if we have a verified track record. Used only by the OPTIONAL
   *  house-lean adjustment in polling-average/weighting.ts, never applied silently. */
  historicalLeanD?: number;
  sourceUrl: string; // pollster's own homepage, for attribution
}

/** What an adapter hands back before validation. Deliberately permissive — validation is a
 *  separate, explicit step (see validation/validatePoll.ts), never skipped. */
export interface RawPollRecord {
  pollsterId: string;         // must match a PollsterConfig.id
  sponsor?: string;           // e.g. "Nexstar Media" — who commissioned it, if not the pollster itself
  sourceUrl: string;          // the exact page/document this record was parsed from
  race: RaceRef;
  fieldStart: string | null;  // ISO date, start of polling
  fieldEnd: string | null;    // ISO date, end of polling
  publishedAt: string | null; // ISO datetime, when the pollster published it
  sampleSize: number | null;
  population: PopulationType;
  marginOfError: number | null; // points
  methodologyNote?: string;
  candidates: Array<{
    name: string;
    party: "D" | "R" | "I" | "O";
    /** Percentage share, 0-100. Never inferred — must come from the source. */
    share: number;
  }>;
  undecidedShare?: number | null;
  otherShare?: number | null;
  /** Free-text — the parser's raw evidence, kept for audit/debugging even after normalization. */
  rawExcerpt?: string;
}

/** A validated, stored poll. Adds identity + provenance the raw record didn't have. */
export interface Poll extends RawPollRecord {
  pollId: string;              // deterministic hash — see validation/dedupe.ts
  ingestedAt: string;          // ISO datetime we accepted it
  ingestionMethod: IngestionMethod;
}

export interface IngestionFailure {
  pollsterId: string;
  sourceUrl?: string;
  reason: string;
  detail?: string;
  occurredAt: string;
}

export interface IngestionRunResult {
  pollsterId: string;
  raceId: RaceId;
  runAt: string;
  fetched: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  failures: IngestionFailure[];
}
