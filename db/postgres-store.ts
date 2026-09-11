import type { Pool } from "pg";
import type { PollStore } from "../ingestion/pipeline";
import type { Poll, RaceId, IngestionRunResult } from "../types/poll";

// ============================================================================
// The persistent replacement for ingestion/pipeline.ts's InMemoryPollStore. Implements the
// exact same PollStore interface — nothing in pipeline.ts, validation, or the adapters
// changes to use this. Written against db/schema.sql exactly as it already existed;
// this file did not require changing the schema.
// ============================================================================

export class PostgresPollStore implements PollStore {
  constructor(private pool: Pool) {}

  async getPollsForRace(raceId: RaceId, geographicId: string | null): Promise<Poll[]> {
    const { rows } = await this.pool.query(
      `SELECT p.*, 
              COALESCE(json_agg(json_build_object('name', c.candidate_name, 'party', c.party, 'share', c.share))
                       FILTER (WHERE c.candidate_name IS NOT NULL), '[]') AS candidates
       FROM polls p
       LEFT JOIN poll_candidates c ON c.poll_id = p.poll_id
       WHERE p.race_id = $1 AND p.geographic_id IS NOT DISTINCT FROM $2
       GROUP BY p.poll_id`,
      [raceId, geographicId]
    );
    return rows.map(rowToPoll);
  }

  async savePoll(poll: Poll): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO polls (poll_id, pollster_id, sponsor, source_url, race_id, geographic_id,
                             field_start, field_end, published_at, sample_size, population,
                             margin_of_error, methodology_note, undecided_share, other_share,
                             raw_excerpt, ingestion_method, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (poll_id) DO NOTHING`,
        [
          poll.pollId, poll.pollsterId, poll.sponsor ?? null, poll.sourceUrl,
          poll.race.raceId, poll.race.geographicId, poll.fieldStart, poll.fieldEnd,
          poll.publishedAt, poll.sampleSize, poll.population, poll.marginOfError,
          poll.methodologyNote ?? null, poll.undecidedShare ?? null, poll.otherShare ?? null,
          poll.rawExcerpt ?? null, poll.ingestionMethod, poll.ingestedAt,
        ]
      );
      for (const c of poll.candidates) {
        await client.query(
          `INSERT INTO poll_candidates (poll_id, candidate_name, party, share)
           VALUES ($1,$2,$3,$4) ON CONFLICT (poll_id, candidate_name) DO UPDATE SET share = EXCLUDED.share`,
          [poll.pollId, c.name, c.party, c.share]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async logFailure(f: IngestionRunResult["failures"][number]): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_failures (pollster_id, source_url, reason, detail, occurred_at) VALUES ($1,$2,$3,$4,$5)`,
      [f.pollsterId, f.sourceUrl ?? null, f.reason, f.detail ?? null, f.occurredAt]
    );
  }

  /** Not part of PollStore — used by the scheduler to record the ingestion_runs audit row
   *  (schema.sql's own stated purpose: "let the frontend show 'last checked' honestly"). */
  async logRun(run: {
    pollsterId: string; raceId: string; geographicId: string | null; runAt: string;
    fetched: number; accepted: number; duplicates: number; rejected: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_runs (pollster_id, race_id, geographic_id, run_at, fetched, accepted, duplicates, rejected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [run.pollsterId, run.raceId, run.geographicId, run.runAt, run.fetched, run.accepted, run.duplicates, run.rejected]
    );
  }
}

export function rowToPoll(row: any): Poll {
  return {
    pollId: row.poll_id,
    pollsterId: row.pollster_id,
    sponsor: row.sponsor ?? undefined,
    sourceUrl: row.source_url,
    race: { raceId: row.race_id, geographicId: row.geographic_id, chamber: "senate" },
    fieldStart: row.field_start ? isoDate(row.field_start) : null,
    fieldEnd: row.field_end ? isoDate(row.field_end) : null,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    sampleSize: row.sample_size,
    population: row.population,
    marginOfError: row.margin_of_error != null ? Number(row.margin_of_error) : null,
    methodologyNote: row.methodology_note ?? undefined,
    candidates: row.candidates ?? [],
    undecidedShare: row.undecided_share != null ? Number(row.undecided_share) : null,
    otherShare: row.other_share != null ? Number(row.other_share) : null,
    rawExcerpt: row.raw_excerpt ?? undefined,
    ingestedAt: new Date(row.ingested_at).toISOString(),
    ingestionMethod: row.ingestion_method,
  };
}

function isoDate(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}
