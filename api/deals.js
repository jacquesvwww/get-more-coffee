/**
 * GET /api/deals — the public JSON the site renders (same shape as the Apps Script ?format=json).
 * Cached at Vercel's edge for CACHE_SECONDS (5 minutes).
 */
import { getDeals } from '../lib/store.js';
import { CONFIG } from '../lib/config.js';

export default async function handler(req, res) {
  try {
    const data = await getDeals();
    // Short edge cache: new deals show within a few minutes of a scrape. The short stale window
    // keeps the site fast while it refreshes, without serving an old copy for hours.
    res.setHeader('Cache-Control', `public, s-maxage=${CONFIG.CACHE_SECONDS}, stale-while-revalidate=60`);
    res.status(200).json(data);
  } catch (err) {
    console.error('GET /api/deals failed:', err && (err.code || ''), err && err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Could not load deals' });
  }
}
