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

/** Admin calls: "Authorization: Bearer <ADMIN_KEY>" header, or ?key=<ADMIN_KEY> for quick browser use. */
export function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return same(header, key) || same(req.query && req.query.key, key);
}

export function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
