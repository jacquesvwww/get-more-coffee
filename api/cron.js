/**
 * Daily scrape, called by Vercel Cron (see vercel.json). Does nothing while AUTO_SCRAPE isn't "true".
 * If one call runs out of time, it hands over to /api/admin?action=continue for the rest.
 */
import { waitUntil } from '@vercel/functions';
import { isCron, origin } from '../lib/auth.js';
import { CONFIG } from '../lib/config.js';
import { scrapeDue } from '../lib/scrape.js';

export default async function handler(req, res) {
  if (!isCron(req)) return res.status(401).json({ error: 'Unauthorised' });
  if (!CONFIG.AUTO_SCRAPE) return res.status(200).json({ paused: true, note: 'Set AUTO_SCRAPE=true to turn daily scraping on' });

  const result = await scrapeDue();
  if (result.remaining && process.env.ADMIN_KEY) {
    waitUntil(fetch(`${origin(req)}/api/admin?action=continue&hop=1`, {
      headers: { authorization: 'Bearer ' + process.env.ADMIN_KEY },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {}));
  }
  res.status(200).json(result);
}
