/**
 * GET /api/deals — the public JSON the site renders (same shape as the Apps Script ?format=json).
 * Cached at Vercel's edge for CACHE_SECONDS, then served stale while it refreshes.
 */
import { getDeals } from '../lib/store.js';
import { CONFIG } from '../lib/config.js';

export default async function handler(req, res) {
  try {
    const data = await getDeals();
    res.setHeader('Cache-Control', `public, s-maxage=${CONFIG.CACHE_SECONDS}, stale-while-revalidate=86400`);
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Could not load deals' });
  }
}
