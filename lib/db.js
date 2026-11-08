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
let customRunner = false;
export function setQuery(fn) { runner = fn; customRunner = true; }

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

// Connection hiccups (a cold start, the pooler dropping an idle connection) are worth one retry.
const RETRYABLE = /CONNECT_TIMEOUT|CONNECTION_(CLOSED|ENDED|DESTROYED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|57P01|08006|08003|08001/;

/** Run a parameterised query and get rows back. Retries once on a dropped or failed connection. */
export async function q(text, params = []) {
  try {
    return Array.from((await getRunner()(text, params)) || []);
  } catch (err) {
    if (!RETRYABLE.test(String((err && (err.code || err.errno)) || '') + ' ' + String(err && err.message))) throw err;
    console.warn('DB connection problem, retrying once:', err.code || err.message);
    if (!customRunner) runner = null;            // build a fresh connection
    await new Promise(r => setTimeout(r, 300));
    return Array.from((await getRunner()(text, params)) || []);
  }
}
