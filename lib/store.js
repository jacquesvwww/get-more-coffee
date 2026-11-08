/**
 * Everything that reads or writes the database: roasters, deals, robots.txt cache,
 * logs, and the public JSON the site renders.
 */
import { q } from './db.js';
import { CONFIG, METHODS } from './config.js';
import { BRANDS_SEED } from './brands.js';
import { SCHEMA_SQL } from './schema.js';
import { howToText_, num_, splitTags_, hash_ } from './parse.js';

// ── row mappers (snake_case in Postgres → camelCase in JS) ──
const toBrand = r => ({
  id: r.id, name: r.name, url: r.url, city: r.city, region: r.region, active: !!r.active,
  affiliateParam: r.affiliate_param, platform: r.platform, lastScraped: r.last_scraped, status: r.status,
  dealCount: r.deal_count, bestPricePerGram: r.best_ppg, failCount: r.fail_count, backoffUntil: r.backoff_until,
  shipping: r.shipping,
});
const toDeal = r => ({
  id: r.id, brand: r.brand, type: r.type, title: r.title, discountText: r.discount_text, percentOff: r.percent_off,
  code: r.code, expires: r.expires, tags: r.tags, pricePerGram: r.price_per_gram, url: r.url, image: r.image,
  sourceText: r.source_text, firstSeen: r.first_seen, lastSeen: r.last_seen, hidden: !!r.hidden, method: r.method,
  howTo: r.how_to, minSpend: r.min_spend, category: r.category, roast: r.roast, shippingNote: r.shipping_note,
});

// ── setup ──
export async function setup() {
  for (const stmt of SCHEMA_SQL.split(/;\s*(?:\n|$)/).map(s => s.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
    await q(stmt);
  }
  const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM brands');
  let seeded = 0;
  if (!n) seeded = await insertBrands(BRANDS_SEED);
  await log('system', 'info', 'Setup complete' + (seeded ? '; seeded ' + seeded + ' roasters' : ''));
  return { ok: true, seeded };
}

async function insertBrands(rows) {
  for (const [name, url, city, region] of rows) {
    await q('INSERT INTO brands (name, url, city, region) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING', [name, url, city, region]);
  }
  return rows.length;
}

/** Adds roasters that are new in lib/brands.js and switches off ones no longer listed. Nothing is deleted. */
export async function syncBrands() {
  const have = await readBrands();
  const seed = new Map(BRANDS_SEED.map(r => [r[0].toLowerCase(), r]));
  let off = 0;
  for (const b of have) {
    if (!seed.has(b.name.toLowerCase()) && b.active) {
      await q("UPDATE brands SET active = FALSE, status = 'not on curated list' WHERE id = $1", [b.id]);
      off++;
    } else if (seed.has(b.name.toLowerCase())) {
      const [, url, city, region] = seed.get(b.name.toLowerCase());
      await q('UPDATE brands SET url = $2, city = $3, region = $4 WHERE id = $1', [b.id, url, city, region]);
    }
  }
  const names = new Set(have.map(b => b.name.toLowerCase()));
  const added = await insertBrands(BRANDS_SEED.filter(r => !names.has(r[0].toLowerCase())));
  await log('system', 'info', `Roaster sync: ${added} added, ${off} switched off`);
  return { added, switchedOff: off };
}

export async function readBrands() {
  return (await q('SELECT * FROM brands ORDER BY name')).map(toBrand);
}

export async function resetLastScraped() { await q('UPDATE brands SET last_scraped = NULL'); }
export async function clearBackoffs() { await q('UPDATE brands SET fail_count = 0, backoff_until = NULL'); }

/** Deletes scraped deals made by older logic (no method or category). Keeps hidden flags on the rest. */
export async function removeOldDeals() {
  const rows = await q('DELETE FROM deals WHERE method IS NULL OR category IS NULL RETURNING id');
  return rows.length;
}

// ── logs ──
export async function log(brand, level, message) {
  try {
    await q('INSERT INTO logs (brand, level, message) VALUES ($1,$2,$3)', [brand, level, String(message).slice(0, 2000)]);
    await q('DELETE FROM logs WHERE at < $1', [daysAgo(60)]);
  } catch (e) { console.log(brand, level, message); }
}

// ── robots.txt cache ──
export async function robotsCacheGet(base) {
  const rows = await q(
    'SELECT rules, delay FROM robots_cache WHERE base = $1 AND fetched_at > $2',
    [base, daysAgo(CONFIG.ROBOTS_CACHE_DAYS)]);
  if (!rows.length) return null;
  const rules = typeof rows[0].rules === 'string' ? JSON.parse(rows[0].rules) : rows[0].rules;
  return { rules, delay: Number(rows[0].delay) || 0 };
}

export async function robotsCachePut(base, robots) {
  await q(`INSERT INTO robots_cache (base, rules, delay, fetched_at) VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (base) DO UPDATE SET rules = EXCLUDED.rules, delay = EXCLUDED.delay, fetched_at = NOW()`,
    [base, JSON.stringify(robots.rules || []), robots.delay || 0]);
}

// ── saving a scrape ──
const DEAL_COLS = ['id', 'brand', 'type', 'title', 'discount_text', 'percent_off', 'code', 'expires', 'tags', 'price_per_gram',
  'url', 'image', 'source_text', 'first_seen', 'last_seen', 'hidden', 'method', 'how_to', 'min_spend', 'category', 'roast', 'shipping_note'];
const daysAgo = n => new Date(Date.now() - n * 864e5);
const blank = v => (v === undefined || v === '' ? null : v);

export async function saveResults(results) {
  const now = new Date();
  for (const r of results) {
    const ok = r.status.indexOf('ok') === 0;
    if (ok) {
      // Same deal as last time (same id) → keep when we first saw it and any "hidden" tick.
      // Only genuinely new ids count as new. Deals gone from the roaster's site are removed,
      // except ones you hid by hand, which are remembered so they stay hidden if they come back.
      const prev = new Map((await q('SELECT id, first_seen, hidden FROM deals WHERE brand = $1', [r.brand.name])).map(d => [d.id, d]));
      const seen = new Set();
      let added = 0, unchanged = 0, ended = 0;
      for (const d of r.deals) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const old = prev.get(d.id);
        if (old) unchanged++; else added++;
        await q('DELETE FROM deals WHERE id = $1', [d.id]);
        const vals = [d.id, d.brand, d.type, d.title, d.discountText, blank(d.percentOff), blank(d.code), blank(d.expires), d.tags,
          blank(d.pricePerGram), d.url, blank(d.image), d.sourceText, old ? old.first_seen : now, now, old ? !!old.hidden : false,
          d.method, d.howTo, blank(d.minSpend), d.category, blank(d.roast), blank(d.shippingNote)];
        await q(`INSERT INTO deals (${DEAL_COLS.join(',')}) VALUES (${DEAL_COLS.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
      }
      for (const [id, old] of prev) {
        if (seen.has(id) || old.hidden) continue;
        await q('DELETE FROM deals WHERE id = $1', [id]);
        ended++;
      }
      r.changes = { added, unchanged, ended };
      r.status += ` · ${added} new · ${unchanged} unchanged · ${ended} ended`;
      if (added || ended) await log(r.brand.name, 'info', `${added} new, ${ended} ended, ${unchanged} unchanged`);
    }

    // Roaster status + polite back-off
    let fails = Number(r.brand.failCount) || 0, until = null;
    if (r.blocked) {
      fails += 1;
      const days = CONFIG.BACKOFF_DAYS[Math.min(fails, CONFIG.BACKOFF_DAYS.length) - 1];
      let t = new Date(now.getTime() + days * 864e5);
      if (r.retryAfter && r.retryAfter > t) t = r.retryAfter;
      until = t;
      r.status += ' — backing off until ' + t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
    } else if (ok) {
      fails = 0;
    }
    await q(`UPDATE brands SET platform = $2, last_scraped = $3, status = $4, deal_count = $5,
               best_ppg = $6, fail_count = $7, backoff_until = $8, shipping = $9
             WHERE id = $1`,
      [r.brand.id, r.platform || r.brand.platform || null, now, r.status, r.deals.length,
        r.bestPricePerGram || r.brand.bestPricePerGram || null, fails, until,
        ok ? (r.shippingNote || null) : (r.brand.shipping || null)]);
    if (!ok) await log(r.brand.name, r.blocked ? 'block' : 'warn', r.status);
  }
}

/**
 * Deletes deals that are over: past their expiry date, not seen for STALE_DAYS, or hidden by you
 * and not seen for DELETE_HIDDEN_AFTER_DAYS. Manual deals are never deleted: expired ones are
 * switched off (active = FALSE). Runs after every scrape, and from ?action=remove-expired.
 */
export async function purgeExpiredDeals(now = new Date()) {
  const ago = n => new Date(now.getTime() - n * 864e5);
  const oldHidden = (await q('DELETE FROM deals WHERE hidden = TRUE AND last_seen < $1 RETURNING id', [ago(CONFIG.DELETE_HIDDEN_AFTER_DAYS)])).length;
  const expired = (await q('DELETE FROM deals WHERE hidden = FALSE AND expires IS NOT NULL AND expires < $1 RETURNING id', [now])).length;
  const stale = (await q('DELETE FROM deals WHERE hidden = FALSE AND last_seen < $1 RETURNING id', [ago(CONFIG.STALE_DAYS)])).length;
  const manual = (await q('UPDATE manual_deals SET active = FALSE WHERE active = TRUE AND expires IS NOT NULL AND expires < $1 RETURNING id', [now])).length;
  return { expired, stale, oldHidden, manual, total: expired + stale + oldHidden + manual };
}

// ── public JSON for the site ──
export async function getDeals() {
  const now = new Date();
  const brands = await readBrands();
  const brandMap = new Map(brands.map(b => [b.name.toLowerCase(), b]));
  const deals = [];

  const scraped = (await q(`SELECT * FROM deals WHERE hidden = FALSE
                              AND (expires IS NULL OR expires > $1)
                              AND (last_seen IS NULL OR last_seen > $2)`, [now, daysAgo(CONFIG.STALE_DAYS)])).map(toDeal);
  for (const d of scraped) {
    const b = brandMap.get(String(d.brand).toLowerCase());
    if (b && !b.active) continue;
    deals.push(publicDeal(d, b, 'scraped'));
  }

  const manual = await q('SELECT * FROM manual_deals WHERE active = TRUE AND (expires IS NULL OR expires > $1)', [now]);
  for (const m of manual) {
    const b = brandMap.get(String(m.brand).toLowerCase());
    const tags = splitTags_(m.tags);
    if (m.code && tags.indexOf('code') < 0) tags.push('code');
    const method = METHODS[String(m.method || '').toLowerCase()] ? String(m.method).toLowerCase() : (m.code ? 'code' : 'automatic');
    deals.push(publicDeal({
      id: 'm-' + hash_(m.id + m.brand + m.title + m.code),
      brand: m.brand, type: tags.indexOf('2-for-1') >= 0 ? 'multibuy' : (m.code ? 'code' : 'sale'),
      title: m.title, discountText: m.discount_text, percentOff: m.percent_off, code: m.code,
      expires: m.expires, tags: tags.join(','), url: m.url || (b && b.url), firstSeen: null,
      method, howTo: m.how_to, minSpend: m.min_spend,
      category: String(m.category || 'coffee').toLowerCase(), roast: String(m.roast || '').toLowerCase(),
    }, b, 'manual'));
  }

  return {
    generatedAt: now.toISOString(),
    brands: brands.filter(b => b.active).map(b => ({
      name: b.name, url: outboundUrl(b.url, b), city: b.city, region: b.region,
      dealCount: Number(b.dealCount) || 0, shipping: b.shipping || '',
    })),
    deals,
  };
}

function publicDeal(d, brand, source) {
  const method = d.method || (d.code ? 'code' : 'automatic');
  return {
    id: String(d.id),
    brand: d.brand,
    type: d.type,
    title: d.title,
    discountText: d.discountText || '',
    percentOff: num_(d.percentOff),
    code: d.code || '',
    expires: d.expires ? new Date(d.expires).toISOString() : '',
    tags: splitTags_(d.tags),
    pricePerGram: CONFIG.SHOW_PRICE_PER_GRAM && d.category === 'coffee' ? num_(d.pricePerGram) : null,
    url: outboundUrl(d.url || (brand && brand.url), brand),
    image: d.image || '',
    region: brand ? brand.region : '',
    firstSeen: d.firstSeen ? new Date(d.firstSeen).toISOString() : '',
    method,
    howTo: d.howTo || howToText_(method, { code: d.code, minSpend: num_(d.minSpend) }),
    minSpend: num_(d.minSpend),
    category: ['coffee', 'equipment', 'other', 'all'].indexOf(d.category) >= 0 ? d.category : 'all',
    roast: ['espresso', 'filter', 'omni', 'all'].indexOf(d.roast) >= 0 ? d.roast : '',
    shippingNote: d.shippingNote || (brand && brand.shipping) || '',
    source,
  };
}

/** Adds UTM + the roaster's optional affiliate parameter to every outbound link. */
export function outboundUrl(url, brand) {
  if (!url) return '';
  let extra = CONFIG.UTM;
  if (brand && brand.affiliateParam) extra += '&' + String(brand.affiliateParam).replace(/^[?&]/, '');
  const [base, hashPart] = String(url).split('#');
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + extra + (hashPart ? '#' + hashPart : '');
}
