import { Pool } from "pg";

// ============================================================================
// Standard DATABASE_URL-based connection. Works unmodified against any real Postgres —
// a local dev instance, Neon, Supabase, RDS, etc. Nothing here is provider-specific except
// the SSL default below, which every major managed Postgres provider (Neon, Supabase, RDS)
// requires and plain localhost doesn't support.
//
// Also handles a real gotcha: node-postgres's Pool emits an 'error' event on an *idle*
// client (e.g. the backend closed the connection, or a managed provider's compute
// auto-suspended mid-connection — Neon does this on the free tier after inactivity). Per
// Node's EventEmitter semantics, an unhandled 'error' event is fatal and crashes the whole
// process. Without the handler below, a single dropped idle connection would take down the
// entire API server or scheduler, not just that one query. This was found by reading
// node-postgres's own docs/issues, not by reproducing the crash here.
// ============================================================================

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. This is required to connect to the persistent poll store.");
    }
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: isLocal ? undefined : { rejectUnauthorized: false }, // required by Neon/Supabase/RDS; not needed/supported by a bare local instance
      max: Number(process.env.DB_POOL_MAX) || 5, // small on purpose — most free-tier managed Postgres caps total connections fairly low
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000, // fail fast rather than hang if the DB (or a suspended Neon compute waking up) is slow to respond
    });
    pool.on("error", (err) => {
      // See file header: without this, a dropped idle connection crashes the process.
      console.error("[db] idle client error (pool recovers automatically):", err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
