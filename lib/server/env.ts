/**
 * Server-only environment validation (Phase B3).
 *
 * Validates ONLY what B3 actually requires. Runs lazily at first server use
 * (never at module import), so `next build` succeeds even when runtime
 * secrets are absent. Errors name the VARIABLE and the problem category —
 * never the value.
 */

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

export interface ServerEnv {
  /** Raw connection string for the PostgreSQL driver adapter. Never logged. */
  databaseUrl: string;
}

/**
 * Read and validate required server variables from the given source
 * (defaults to process.env — tests inject their own).
 * Throws Error with `SERVER_ENV_MISSING` / `SERVER_ENV_INVALID` prefixes.
 */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const raw = source.DATABASE_URL;
  if (!raw || raw.trim() === "") {
    throw new Error("SERVER_ENV_MISSING: required variable DATABASE_URL is not set (see .env.example).");
  }
  if (!POSTGRES_URL.test(raw.trim())) {
    throw new Error("SERVER_ENV_INVALID: variable DATABASE_URL must be a postgresql:// connection string.");
  }
  return { databaseUrl: raw.trim() };
}
