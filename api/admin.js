/**
 * /api/admin?action=…  — replaces the ☕ menu from the Google Sheet version.
 * Needs your ADMIN_KEY: send "Authorization: Bearer <ADMIN_KEY>", or add &key=<ADMIN_KEY>.
 *
 *   setup          create tables and seed the roaster list (safe to re-run)
 *   sync-brands    add new roasters from lib/brands.js, switch off removed ones
 *   scrape-now     re-check every active roaster now (keeps rate limits and back-offs)
 *   scrape         check only roasters that are due
 *   scrape-brand   &brand=Assembly%20Coffee  — re-check one roaster
 *   remove-expired delete expired / ended deals now (also runs after every scrape)
 *   rebuild        delete deals made by older logic, then scrape everything
 *   clear-backoffs reset back-offs for every roaster
 *   status         roaster statuses and the latest log lines
 *   continue       (internal) picks up a scrape that ran out of time
 */
import { waitUntil } from '@vercel/functions';
import { isAdmin, origin } from '../lib/auth.js';
import { scrapeDue } from '../lib/scrape.js';
import { q } from '../lib/db.js';
import { clearBackoffs, purgeExpiredDeals, readBrands, removeOldDeals, resetLastScraped, setup, syncBrands } from '../lib/store.js';

const MAX_HOPS = 30; // safety net so a chain of follow-up calls can never loop forever

export default async function handler(req, res) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorised' });
  const action = String(req.query.action || 'status');
  const hop = Number(req.query.hop || 0);

  // Runs a scrape and, if roasters are still due, hands over to a fresh function call.
  const scrapeAndChain = async (opts = {}) => {
    const result = await scrapeDue(opts);
    if (result.remaining && !opts.onlyBrand && hop < MAX_HOPS) {
      waitUntil(fetch(`${origin(req)}/api/admin?action=continue&hop=${hop + 1}`, {
        headers: { authorization: 'Bearer ' + process.env.ADMIN_KEY },
        signal: AbortSignal.timeout(5000), // just hand over: don't keep this call alive waiting for the next one
      }).catch(() => {}));
      result.continuing = true;
    }
    return result;
  };

  try {
    switch (action) {
      case 'setup': return res.json(await setup());
      case 'sync-brands': return res.json(await syncBrands());
      case 'scrape-now': await resetLastScraped(); return res.json(await scrapeAndChain());
      case 'scrape':
      case 'continue': return res.json(await scrapeAndChain());
      case 'scrape-brand': {
        if (!req.query.brand) return res.status(400).json({ error: 'Add &brand=<roaster name>' });
        return res.json(await scrapeDue({ onlyBrand: req.query.brand }));
      }
      case 'rebuild': {
        const removed = await removeOldDeals();
        await resetLastScraped();
        return res.json({ removed, ...(await scrapeAndChain()) });
      }
      case 'remove-expired': return res.json(await purgeExpiredDeals());
      case 'clear-backoffs': await clearBackoffs(); return res.json({ ok: true });
      case 'status': {
        const brands = (await readBrands()).map(b => ({
          name: b.name, active: b.active, platform: b.platform, status: b.status, deals: b.dealCount,
          lastScraped: b.lastScraped, backoffUntil: b.backoffUntil, shipping: b.shipping,
        }));
        const logs = await q('SELECT at, brand, level, message FROM logs ORDER BY at DESC LIMIT 50');
        return res.json({ brands, logs });
      }
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}
