/**
 * The polite scraper. Each round hits each roaster at most once, different roasters
 * in parallel, with pauses between rounds so no single site sees two requests close together.
 */
import { CONFIG } from './config.js';
import {
  baseUrl_, buildDeals_, detectCurrency_, detectPlatform_, extractPromoLines_, isAllowed_,
  parseRobots_, parseShopifyProducts_, parseWooProducts_,
} from './parse.js';
import { log, purgeExpiredDeals, readBrands, robotsCacheGet, robotsCachePut, saveResults } from './store.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hoursSince = d => (d ? (Date.now() - new Date(d).getTime()) / 36e5 : Infinity);

/** fetch → {code, text, headers}; null on network failure. */
async function get(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept-Language': 'en-GB' },
      signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS),
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { code: res.status, text: await res.text(), headers };
  } catch (e) {
    return null;
  }
}
const getAll = urls => Promise.all(urls.map(get));

/** Flags "please stop" responses so we back off. Honours Retry-After. */
function noteBlock(r, res) {
  if ([403, 429, 503].indexOf(res.code) < 0) return;
  r.blocked = true;
  const ra = res.headers && res.headers['retry-after'];
  if (ra) {
    const secs = /^\d+$/.test(String(ra).trim()) ? +ra : (new Date(ra).getTime() - Date.now()) / 1000;
    if (secs > 0) r.retryAfter = new Date(Date.now() + secs * 1000);
  }
}

/** Fetch + parse a batch of roasters. */
export async function scrapeBrands(brands) {
  const results = brands.map(b => ({ brand: b, base: baseUrl_(b.url), platform: '', status: '', promos: [], products: [], deals: [], robots: null, retryAfter: null }));

  // Round 0: robots.txt — only when the weekly cache is stale
  const needRobots = [];
  for (const r of results) { r.robots = await robotsCacheGet(r.base); if (!r.robots) needRobots.push(r); }
  if (needRobots.length) {
    const res = await getAll(needRobots.map(r => r.base + '/robots.txt'));
    for (let k = 0; k < res.length; k++) {
      const r = needRobots[k], x = res[k];
      if (x && x.code >= 200 && x.code < 300) { r.robots = parseRobots_(x.text); await robotsCachePut(r.base, r.robots); }
      else if (x && x.code >= 400 && x.code < 500 && [401, 403, 429].indexOf(x.code) < 0) { r.robots = { rules: [], delay: 0 }; await robotsCachePut(r.base, r.robots); } // no robots.txt = allowed
      else { r.robots = null; r.status = x ? 'robots.txt HTTP ' + x.code + ' — skipped today' : 'robots.txt unreachable — skipped today'; if (x) noteBlock(r, x); }
    }
    await sleep(CONFIG.MIN_GAP_SAME_SITE_MS);
  }

  // Round 1: homepage (asking for UK prices in pounds)
  const r1 = results.filter(r => !r.status && r.robots && isAllowed_(r.robots.rules, '/'));
  results.forEach(r => { if (!r.status && r.robots && !isAllowed_(r.robots.rules, '/')) r.status = 'blocked by robots.txt'; });
  const homes = await getAll(r1.map(r => r.base + '/' + CONFIG.LOCALE_QUERY));
  homes.forEach((home, k) => {
    const r = r1[k];
    if (!home || home.code >= 400) { r.status = home ? 'HTTP ' + home.code : 'fetch failed'; if (home) noteBlock(r, home); return; }
    r.platform = detectPlatform_(home.text);
    r.currency = detectCurrency_(home.text);
    r.promos = extractPromoLines_(home.text);
    r.status = 'ok';
  });

  // Round 2: product feed — after the larger of our own gap and the site's Crawl-delay
  const r2 = [];
  let wait = CONFIG.MIN_GAP_SAME_SITE_MS;
  for (const r of results) {
    if (r.status !== 'ok') continue;
    let path = '';
    if (r.platform === 'shopify') path = '/products.json?limit=250&' + CONFIG.LOCALE_QUERY.slice(1);
    else if (r.platform === 'woocommerce') path = '/wp-json/wc/store/v1/products?per_page=100';
    if (path && r.currency && r.currency !== 'GBP') { r.status += ' (feed skipped: prices in ' + r.currency + ')'; continue; }
    if (!path || !isAllowed_(r.robots.rules, path.split('?')[0])) continue;
    const delay = (r.robots.delay || 0) * 1000;
    if (delay > CONFIG.MAX_CRAWL_DELAY_MS) { r.status += ' (feed skipped: Crawl-delay ' + r.robots.delay + 's)'; continue; }
    wait = Math.max(wait, delay);
    r.feedUrl = r.base + path;
    r2.push(r);
  }
  if (r2.length) {
    await sleep(wait);
    const feeds = await getAll(r2.map(r => r.feedUrl));
    feeds.forEach((resp, k) => {
      const r = r2[k];
      if (!resp || resp.code !== 200) { r.status += ' (feed HTTP ' + (resp ? resp.code : '—') + ')'; if (resp) noteBlock(r, resp); return; }
      try {
        const json = JSON.parse(resp.text);
        r.products = r.platform === 'shopify' ? parseShopifyProducts_(json, r.base) : parseWooProducts_(json);
      } catch (err) { r.status += ' (feed parse error)'; }
    });
  }

  results.forEach(r => { r.deals = buildDeals_(r); });
  return results;
}

/**
 * Scrapes roasters that are due (not visited in RESCRAPE_HOURS, not in back-off), oldest first,
 * until the time budget for this function call runs out.
 * Returns { done, remaining } so the caller can chain another call if needed.
 */
export async function scrapeDue({ budgetMs = CONFIG.RUN_BUDGET_MS, onlyBrand = null } = {}) {
  const start = Date.now(), now = new Date();
  let brands = (await readBrands()).filter(b => b.active && b.url);
  if (onlyBrand) brands = brands.filter(b => b.name.toLowerCase() === String(onlyBrand).toLowerCase());
  const resting = brands.filter(b => b.backoffUntil && new Date(b.backoffUntil) > now).length;
  const due = brands
    .filter(b => onlyBrand || !(b.backoffUntil && new Date(b.backoffUntil) > now))
    .filter(b => onlyBrand || hoursSince(b.lastScraped) >= CONFIG.RESCRAPE_HOURS)
    .sort((a, b) => new Date(a.lastScraped || 0) - new Date(b.lastScraped || 0));

  // Worst case for one batch: robots gap + feed wait + network time.
  const batchBudget = CONFIG.MIN_GAP_SAME_SITE_MS + Math.max(CONFIG.MIN_GAP_SAME_SITE_MS, CONFIG.MAX_CRAWL_DELAY_MS) + CONFIG.FETCH_TIMEOUT_MS;
  let done = 0;
  while (due.length && (done === 0 || Date.now() - start < budgetMs - batchBudget)) {
    const batch = due.splice(0, CONFIG.BATCH_SIZE);
    await saveResults(await scrapeBrands(batch));
    done += batch.length;
    if (due.length && Date.now() - start < budgetMs - batchBudget) await sleep(CONFIG.PAUSE_BETWEEN_BATCHES_MS);
  }
  const purged = await purgeExpiredDeals();
  await log('system', 'info', `Scraped ${done} roasters; ${due.length} still due; ${resting} in back-off` +
    (purged.total ? `; removed ${purged.total} expired/ended` : ''));
  return { done, remaining: due.length, resting, purged };
}
