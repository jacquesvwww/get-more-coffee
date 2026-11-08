/**
 * Database access via the standard Postgres driver ("postgres"), so it works with
 * Supabase, Neon or any other Postgres.
 *
 * Supabase: use the *Transaction pooler* connection string (port 6543) from
 * Project → Connect, and put it in DATABASE_URL. The pooler suits serverless
 * functions, which open lots of short-lived connections.
 */
import postgres from 'postgres';

let runner = null;

/** Tests can swap in another query function: (text, params) => Promise<rows[]> */
export function setQuery(fn) { runner = fn; }

function getRunner() {
  if (runner) return runner;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    prepare: false,          // required by Supabase's transaction pooler (and harmless elsewhere)
    max: 1,                  // one connection per function instance is plenty
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},      // hide harmless "already exists, skipping" notices
    ssl: local ? false : 'require',
  });
  runner = (text, params = []) => sql.unsafe(text, params);
  return runner;
}

/** Run a parameterised query and get rows back. */
export async function q(text, params = []) {
  const out = await getRunner()(text, params);
  return Array.from(out || []);
}
