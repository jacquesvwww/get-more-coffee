/** Small helpers shared by the API routes. */
import { timingSafeEqual } from 'node:crypto';

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". */
export function isCron(req) {
  return !!process.env.CRON_SECRET && same(req.headers.authorization, 'Bearer ' + process.env.CRON_SECRET);
}

// Trim stray spaces/new lines that sneak in when a key is pasted into Vercel or the address bar.
const clean = v => String(v || '').trim();

/** Admin calls: "Authorization: Bearer <ADMIN_KEY>" header, or ?key=<ADMIN_KEY> for quick browser use. */
export function isAdmin(req) {
  const key = clean(process.env.ADMIN_KEY);
  if (!key) return false;
  const header = clean(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  return same(header, key) || same(clean(req.query && req.query.key), key);
}

/** Why an admin call was refused, without revealing anything about the key itself. */
export function adminProblem(req) {
  if (!clean(process.env.ADMIN_KEY)) return 'ADMIN_KEY is not set for this deployment. Add it in Vercel (tick Production), then redeploy.';
  if (!clean(req.query && req.query.key) && !req.headers.authorization) return 'No key was sent. Add &key=YOUR_ADMIN_KEY to the end of the address.';
  return 'The key does not match ADMIN_KEY. Check for typos, and use letters and numbers only.';
}

export function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
