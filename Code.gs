/**
 * ╔══════════════════════════════════════════════════════════════╗
 *   GET MORE COFFEE — getmore.coffee
 *   Google Apps Script backend: scraper + Google Sheet "database" + web app
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * How it works
 *  1. setup() creates the sheets (Brands, Deals, Manual Deals, Log), seeds the
 *     roaster list and installs ONE daily trigger (03:00–04:00 UK time).
 *  2. scrapeDueBrands() visits every active roaster once a day:
 *       • homepage  → announcement-bar / banner text → codes, % off,
 *                     free shipping, 2-for-1, expiry dates
 *       • Shopify   → /products.json  → sale prices + price per gram
 *       • WooCommerce → Store API     → sale prices + price per gram
 *     Politeness: robots.txt is respected (incl. Crawl-delay) and cached for a
 *     week, only ~2 requests per roaster per day, never two requests to the same
 *     site at once, and any roaster that answers 403/429/503 is left alone for
 *     1 → 2 → 4 → 7 → 14 days (or longer if it sends Retry-After).
 *  3. doGet() serves Index.html. ?format=json returns the same data as JSON
 *     so a front end on getmore.coffee (e.g. Vercel) can use it.
 */

// ─────────────────────────────── CONFIG ───────────────────────────────
const CONFIG = {
  SITE_URL: 'https://getmore.coffee',
  MAX_SALE_PERCENT: 70,
  // Banner offers with no code ("2 for 1 this weekend", "15% off everything") can't be
  // checked until checkout and make shoppers click around. Off for now; set true to bring back.
  INCLUDE_CHECKOUT_DEALS: false,              // anything deeper is almost always bad shop data, not a real sale
  USER_AGENT: 'Mozilla/5.0 (compatible; GetMoreCoffeeBot/0.1; +https://getmore.coffee/bot)',
  // ── Schedule ──
  AUTO_SCRAPE: false,                // daily scraping is PAUSED while the design is finished. Set true (then run setup) to switch it back on.
  DAILY_RUN_HOUR: 3,                 // when switched on: once a day between 03:00 and 04:00 UK time
  CONTINUE_AFTER_MIN: 15,            // if a run hits the time limit, it picks up again 15 min later
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,   // Apps Script hard limit is 6 min per run
  RESCRAPE_HOURS: 20,                // a roaster is never visited more than once per ~day
  // ── Rate limits / politeness ──
  BATCH_SIZE: 5,                     // different roasters fetched side by side (never 2 at once to one site)
  PAUSE_BETWEEN_BATCHES_MS: 3000,    // breather between batches
  MIN_GAP_SAME_SITE_MS: 5000,        // min gap between two requests to the same roaster
  MAX_CRAWL_DELAY_MS: 30000,         // honour robots.txt Crawl-delay up to this; above it we skip the product feed
  ROBOTS_CACHE_DAYS: 7,              // re-read robots.txt weekly, not daily
  BACKOFF_DAYS: [1, 2, 4, 7, 14],    // after a 403/429/503, leave the roaster alone this long (grows each time)
  STALE_DAYS: 3,                     // hide scraped deals not re-seen for this long
  MAX_SALE_DEALS_PER_BRAND: 6,      // per category (coffee / equipment / other)
  MIN_SALE_PERCENT: 5,
  CACHE_SECONDS: 600,
  UTM: 'utm_source=getmore.coffee&utm_medium=referral&utm_campaign=deals',
};

const SHEETS = { BRANDS: 'Brands', DEALS: 'Deals', MANUAL: 'Manual Deals', LOG: 'Log' };

const BRAND_HEADERS = ['name', 'url', 'city', 'region', 'active', 'affiliateParam',
  'platform', 'lastScraped', 'status', 'dealCount', 'bestPricePerGram', 'failCount', 'backoffUntil', 'shipping'];

const DEAL_HEADERS = ['id', 'brand', 'type', 'title', 'discountText', 'percentOff', 'code',
  'expires', 'tags', 'pricePerGram', 'url', 'image', 'sourceText', 'firstSeen', 'lastSeen', 'hidden',
  'method', 'howTo', 'minSpend', 'category', 'roast', 'shippingNote'];

/**
 * How a shopper actually gets the discount. Every deal has exactly one method;
 * extra conditions (first order only, minimum spend) are added to the howTo text.
 */
const METHODS = {
  automatic: 'No code needed',
  code: 'Promo code',
  newsletter: 'Newsletter sign-up',
  subscription: 'Subscription',
};

const MANUAL_HEADERS = ['brand', 'title', 'discountText', 'percentOff', 'code', 'expires',
  'tags', 'pricePerGram', 'url', 'active', 'notes', 'method', 'howTo', 'minSpend', 'category', 'roast'];

// ───────────────────────────── WEB APP ────────────────────────────────
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.format === 'json') {
    return ContentService.createTextOutput(JSON.stringify(getDeals()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const t = HtmlService.createTemplateFromFile('Index');
  // Inline the data so the page renders with no second round trip.
  t.payload = JSON.stringify(getDeals()).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Get More Coffee — UK specialty coffee deals')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Public data for the front end (also callable via google.script.run). */
function getDeals() {
  const cached = cacheGet_('gmc:deals');
  if (cached) return cached;

  const now = new Date();
  const brands = readBrands_();
  const brandMap = {};
  brands.forEach(b => { brandMap[b.name.toLowerCase()] = b; });

  const staleBefore = new Date(now.getTime() - CONFIG.STALE_DAYS * 864e5);
  const deals = [];

  readObjects_(SHEETS.DEALS).forEach(d => {
    if (truthy_(d.hidden)) return;
    if (d.expires && new Date(d.expires) < now) return;
    if (d.lastSeen && new Date(d.lastSeen) < staleBefore) return;
    const b = brandMap[String(d.brand).toLowerCase()];
    if (b && !b.active) return;
    deals.push(publicDeal_(d, b, 'scraped'));
  });

  readObjects_(SHEETS.MANUAL).forEach(m => {
    if (!m.brand || !truthy_(m.active === '' ? true : m.active)) return;
    if (m.expires && new Date(m.expires) < now) return;
    const b = brandMap[String(m.brand).toLowerCase()];
    const tags = splitTags_(m.tags);
    if (m.code && tags.indexOf('code') < 0) tags.push('code');
    deals.push(publicDeal_({
      id: 'm-' + hash_(m.brand + m.title + m.code),
      brand: m.brand, type: tags.indexOf('2-for-1') >= 0 ? 'multibuy' : (m.code ? 'code' : 'sale'),
      title: m.title, discountText: m.discountText, percentOff: m.percentOff, code: m.code,
      expires: m.expires, tags: tags.join(','), pricePerGram: m.pricePerGram,
      url: m.url || (b && b.url), firstSeen: '', lastSeen: now,
      method: METHODS[String(m.method).toLowerCase()] ? String(m.method).toLowerCase() : (m.code ? 'code' : 'automatic'),
      howTo: m.howTo, minSpend: m.minSpend,
      category: String(m.category || 'coffee').toLowerCase(), roast: String(m.roast || '').toLowerCase(),
    }, b, 'manual'));
  });

  const out = {
    generatedAt: now.toISOString(),
    brands: brands.filter(b => b.active).map(b => ({
      name: b.name, url: outboundUrl_(b.url, b), city: b.city, region: b.region,
      bestPricePerGram: num_(b.bestPricePerGram), dealCount: num_(b.dealCount) || 0, shipping: b.shipping || '',
    })),
    deals: deals,
  };
  cachePut_('gmc:deals', out);
  return out;
}

function publicDeal_(d, brand, source) {
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
    pricePerGram: num_(d.pricePerGram),
    url: outboundUrl_(d.url || (brand && brand.url), brand),
    image: d.image || '',
    region: brand ? brand.region : '',
    firstSeen: d.firstSeen ? new Date(d.firstSeen).toISOString() : '',
    method: d.method || (d.code ? 'code' : 'automatic'),
    howTo: d.howTo || howToText_(d.method || (d.code ? 'code' : 'automatic'), { code: d.code, minSpend: num_(d.minSpend) }),
    minSpend: num_(d.minSpend),
    category: ['coffee', 'equipment', 'other', 'all'].indexOf(d.category) >= 0 ? d.category : 'all',
    roast: ['espresso', 'filter', 'omni', 'all'].indexOf(d.roast) >= 0 ? d.roast : '',
    shippingNote: d.shippingNote || (brand && brand.shipping) || '',
    source: source,
  };
}

/** Adds UTM + optional affiliate parameter (Brands sheet column). */
function outboundUrl_(url, brand) {
  if (!url) return '';
  let extra = CONFIG.UTM;
  if (brand && brand.affiliateParam) extra += '&' + String(brand.affiliateParam).replace(/^[?&]/, '');
  const [base, hashPart] = String(url).split('#');
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + extra + (hashPart ? '#' + hashPart : '');
}

// ───────────────────────────── SETUP / MENU ───────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('☕ Get More Coffee')
    .addItem('1. Set up sheets', 'setup')
    .addItem('Scrape now', 'scrapeNow')
    .addItem('Scrape selected roaster row', 'scrapeSelectedBrand')
    .addItem('Clear all back-offs', 'clearBackoffs')
    .addItem('Remove old deals + rebuild', 'rebuildDeals')
    .addItem('Clear site cache', 'clearCache')
    .addToUi();
}

function setup() {
  const ss = getSS_();
  ensureSheet_(ss, SHEETS.BRANDS, BRAND_HEADERS);
  ensureSheet_(ss, SHEETS.DEALS, DEAL_HEADERS);
  ensureSheet_(ss, SHEETS.MANUAL, MANUAL_HEADERS);
  ensureSheet_(ss, SHEETS.LOG, ['time', 'brand', 'level', 'message']);

  const brandSheet = ss.getSheetByName(SHEETS.BRANDS);
  if (brandSheet.getLastRow() < 2) {
    const rows = BRANDS_SEED.map(r => [r[0], r[1], r[2], r[3], true, '', '', '', '', '', '', 0, '', '']);
    brandSheet.getRange(2, 1, rows.length, BRAND_HEADERS.length).setValues(rows);
    brandSheet.getRange(2, 5, rows.length, 1).insertCheckboxes();
  }
  const manual = ss.getSheetByName(SHEETS.MANUAL);
  if (manual.getLastRow() < 2) {
    manual.getRange(2, 1, 1, MANUAL_HEADERS.length).setValues([[
      'Example Roaster', 'Delete me — example manual deal', '20% off', 20, 'EXAMPLE20', '',
      'code', '', 'https://example.com', false, 'Use this sheet for affiliate-network or hand-found deals',
      'code', '', '', 'coffee', '']]);
  }
  installTriggers_();
  log_('system', 'info', 'Setup complete');
}

/**
 * Removes any existing daily scrape trigger. Only adds one back when CONFIG.AUTO_SCRAPE is true.
 * (Apps Script picks a random minute inside the hour, which adds natural jitter.)
 */
function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['scrapeDueBrands', 'continueScrape'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  if (!CONFIG.AUTO_SCRAPE) { log_('system', 'info', 'Daily scraping is paused (CONFIG.AUTO_SCRAPE = false). Use ☕ menu → Scrape now.'); return; }
  ScriptApp.newTrigger('scrapeDueBrands').timeBased()
    .everyDays(1).atHour(CONFIG.DAILY_RUN_HOUR).inTimezone('Europe/London').create();
}

/**
 * Manual scrape from the ☕ menu. Re-checks every active roaster now, ignoring the
 * once-a-day rule but still respecting back-offs and all the rate limits.
 */
function scrapeNow() {
  resetLastScraped();
  scrapeDueBrands();
}

/** One-off follow-up used only when the daily run didn't get through every roaster. */
function continueScrape() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'continueScrape') ScriptApp.deleteTrigger(t); });
  scrapeDueBrands();
}

function scheduleContinuation_() {
  const already = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'continueScrape');
  if (!already) ScriptApp.newTrigger('continueScrape').timeBased().after(CONFIG.CONTINUE_AFTER_MIN * 60 * 1000).create();
}

/**
 * One-off clean-up after a logic change. Deletes every scraped deal made by the old
 * logic (they have no "method" or "category"), keeps your hidden flags on the rest, clears the site
 * cache and starts a fresh, rate-limited pass over all roasters.
 */
function rebuildDeals() {
  const sh = getSS_().getSheetByName(SHEETS.DEALS);
  const all = readObjects_(SHEETS.DEALS);
  const keep = all.filter(d => d.method && d.category);   // rows from older logic lack these
  const removed = all.length - keep.length;
  sh.getRange(1, 1, 1, DEAL_HEADERS.length).setValues([DEAL_HEADERS]);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), DEAL_HEADERS.length)).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, DEAL_HEADERS.length)
    .setValues(keep.map(d => DEAL_HEADERS.map(h => (d[h] === undefined || d[h] === null) ? '' : d[h])));
  clearCache();
  resetLastScraped();
  log_('system', 'info', 'Rebuild: removed ' + removed + ' old-logic deals, kept ' + keep.length);
  scrapeDueBrands();
}

function clearBackoffs() {
  const sh = getSS_().getSheetByName(SHEETS.BRANDS);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, BRAND_HEADERS.indexOf('failCount') + 1, n, 2).setValues(Array.from({ length: n }, () => [0, '']));
}

function resetLastScraped() {
  const sh = getSS_().getSheetByName(SHEETS.BRANDS);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, BRAND_HEADERS.indexOf('lastScraped') + 1, n, 1).clearContent();
}

function clearCache() { CacheService.getScriptCache().remove('gmc:deals:n'); }

// ───────────────────────────── SCRAPER ────────────────────────────────
/** Daily trigger. Scrapes roasters not visited in RESCRAPE_HOURS and not in back-off, oldest first. */
function scrapeDueBrands() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const start = Date.now(), now = new Date();
    const brands = readBrands_().filter(b => b.active && b.url);
    const resting = brands.filter(b => b.backoffUntil && new Date(b.backoffUntil) > now).length;
    const due = brands
      .filter(b => !(b.backoffUntil && new Date(b.backoffUntil) > now))
      .filter(b => hoursSince_(b.lastScraped) >= CONFIG.RESCRAPE_HOURS)
      .sort((a, b) => (new Date(a.lastScraped || 0)) - (new Date(b.lastScraped || 0)));
    // Leave headroom for the pauses inside a batch so we never hit the 6-minute wall.
    const batchBudget = CONFIG.MIN_GAP_SAME_SITE_MS * 2 + CONFIG.MAX_CRAWL_DELAY_MS + 15000;
    let done = 0;
    while (due.length && Date.now() - start < CONFIG.MAX_RUNTIME_MS - batchBudget) {
      const batch = due.splice(0, CONFIG.BATCH_SIZE);
      saveResults_(scrapeBrands_(batch));
      done += batch.length;
      if (due.length) Utilities.sleep(CONFIG.PAUSE_BETWEEN_BATCHES_MS);
    }
    if (done) clearCache();
    if (due.length) scheduleContinuation_();
    log_('system', 'info', 'Scraped ' + done + ' roasters; ' + due.length + ' still due' +
      (due.length ? ' (continuing in ' + CONFIG.CONTINUE_AFTER_MIN + ' min)' : '') + '; ' + resting + ' in back-off');
  } finally {
    lock.releaseLock();
  }
}

function scrapeSelectedBrand() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.BRANDS) throw new Error('Select a row on the Brands sheet first');
  const row = sh.getActiveRange().getRow();
  const b = readBrands_().filter(x => x._row === row)[0];
  if (!b) throw new Error('No brand on that row');
  saveResults_(scrapeBrands_([b]));
  clearCache();
}

/**
 * Fetch + parse a batch of roasters. Each round hits each roaster at most once,
 * different roasters in parallel, with a pause between rounds so no single site
 * ever sees two requests from us close together.
 */
function scrapeBrands_(brands) {
  const fetchOpts = url => ({
    url: url, muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept-Language': 'en-GB' },
  });
  const results = brands.map(b => ({ brand: b, base: baseUrl_(b.url), platform: '', status: '', promos: [], products: [], deals: [], robots: null, retryAfter: null }));

  // Round 0: robots.txt — only when the weekly cache is stale
  const needRobots = [];
  results.forEach(r => { r.robots = robotsCacheGet_(r.base); if (!r.robots) needRobots.push(r); });
  if (needRobots.length) {
    safeFetchAll_(needRobots.map(r => fetchOpts(r.base + '/robots.txt'))).forEach((res, k) => {
      const r = needRobots[k];
      if (res && res.code >= 200 && res.code < 300) { r.robots = parseRobots_(res.text); robotsCachePut_(r.base, r.robots); }
      else if (res && res.code >= 400 && res.code < 500 && [401, 403, 429].indexOf(res.code) < 0) { r.robots = { rules: [], delay: 0 }; robotsCachePut_(r.base, r.robots); } // no robots.txt = allowed
      else { r.robots = null; r.status = res ? 'robots.txt HTTP ' + res.code + ' — skipped today' : 'robots.txt unreachable — skipped today'; if (res) noteBlock_(r, res); }
    });
    Utilities.sleep(CONFIG.MIN_GAP_SAME_SITE_MS);
  }

  // Round 1: homepage
  const r1 = results.filter(r => !r.status && r.robots && isAllowed_(r.robots.rules, '/'));
  results.forEach(r => { if (!r.status && r.robots && !isAllowed_(r.robots.rules, '/')) r.status = 'blocked by robots.txt'; });
  safeFetchAll_(r1.map(r => fetchOpts(r.base + '/'))).forEach((home, k) => {
    const r = r1[k];
    if (!home || home.code >= 400) { r.status = home ? 'HTTP ' + home.code : 'fetch failed'; if (home) noteBlock_(r, home); return; }
    r.platform = detectPlatform_(home.text);
    r.promos = extractPromoLines_(home.text);
    r.status = 'ok';
  });

  // Round 2: product feed — after waiting the larger of our own gap and the site's Crawl-delay
  const r2 = [];
  let wait = CONFIG.MIN_GAP_SAME_SITE_MS;
  results.forEach(r => {
    if (r.status !== 'ok') return;
    let path = '';
    if (r.platform === 'shopify') path = '/products.json?limit=250';
    else if (r.platform === 'woocommerce') path = '/wp-json/wc/store/v1/products?per_page=100';
    if (!path || !isAllowed_(r.robots.rules, path.split('?')[0])) return;
    const delay = (r.robots.delay || 0) * 1000;
    if (delay > CONFIG.MAX_CRAWL_DELAY_MS) { r.status += ' (feed skipped: Crawl-delay ' + r.robots.delay + 's)'; return; }
    wait = Math.max(wait, delay);
    r.feedUrl = r.base + path;
    r2.push(r);
  });
  if (r2.length) {
    Utilities.sleep(wait);
    safeFetchAll_(r2.map(r => fetchOpts(r.feedUrl))).forEach((resp, k) => {
      const r = r2[k];
      if (!resp || resp.code !== 200) { r.status += ' (feed HTTP ' + (resp ? resp.code : '—') + ')'; if (resp) noteBlock_(r, resp); return; }
      try {
        const json = JSON.parse(resp.text);
        r.products = r.platform === 'shopify' ? parseShopifyProducts_(json, r.base) : parseWooProducts_(json);
      } catch (err) { r.status += ' (feed parse error)'; }
    });
  }

  results.forEach(r => { r.deals = buildDeals_(r); });
  return results;
}

/** Flags "please stop" responses so saveResults_ can back off. Honours Retry-After. */
function noteBlock_(r, res) {
  if ([403, 429, 503].indexOf(res.code) < 0) return;
  r.blocked = true;
  const ra = res.headers && (res.headers['Retry-After'] || res.headers['retry-after']);
  if (ra) {
    const secs = /^\d+$/.test(String(ra).trim()) ? +ra : (new Date(ra).getTime() - Date.now()) / 1000;
    if (secs > 0) r.retryAfter = new Date(Date.now() + secs * 1000);
  }
}

/** Runs UrlFetchApp.fetchAll and normalises to {code, text, headers}. */
function safeFetchAll_(requests) {
  if (!requests.length) return [];
  const norm = res => ({ code: res.getResponseCode(), text: res.getContentText(), headers: res.getHeaders() });
  try {
    return UrlFetchApp.fetchAll(requests).map(norm);
  } catch (err) {
    // One bad host (DNS etc.) fails the whole fetchAll — fall back to one by one.
    return requests.map(req => {
      try { return norm(UrlFetchApp.fetch(req.url, req)); }
      catch (e) { return null; }
    });
  }
}

function robotsCacheGet_(base) {
  try {
    const v = PropertiesService.getScriptProperties().getProperty('robots:' + base);
    if (!v) return null;
    const o = JSON.parse(v);
    return Date.now() - o.t < CONFIG.ROBOTS_CACHE_DAYS * 864e5 ? { rules: o.rules, delay: o.delay } : null;
  } catch (e) { return null; }
}

function robotsCachePut_(base, robots) {
  let rules = robots.rules;
  let json = JSON.stringify({ t: Date.now(), rules: rules, delay: robots.delay });
  while (json.length > 8000 && rules.length) { rules = rules.slice(0, Math.floor(rules.length * 0.8)); json = JSON.stringify({ t: Date.now(), rules: rules, delay: robots.delay }); }
  try { PropertiesService.getScriptProperties().setProperty('robots:' + base, json); } catch (e) { /* store full — just refetch next time */ }
}

// ───────────────────────── PARSING (pure functions) ────────────────────
function detectPlatform_(html) {
  if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html)) return 'shopify';
  if (/woocommerce|wp-content\/plugins\/woo/i.test(html)) return 'woocommerce';
  if (/static1\.squarespace\.com|squarespace-cdn/i.test(html)) return 'squarespace';
  if (/wixstatic\.com|wix\.com/i.test(html)) return 'wix';
  if (/bigcommerce/i.test(html)) return 'bigcommerce';
  return 'other';
}

const PROMO_RE = new RegExp([
  '\\d{1,2}\\s?%\\s?off', 'save\\s+(?:up\\s+to\\s+)?(?:£\\d|\\d{1,2}\\s?%)', '£\\d+(?:\\.\\d\\d)?\\s+off',
  'free\\s+(?:(?:uk|mainland|standard|tracked|next[- ]day|royal\\s+mail)\\s+)*(?:shipping|delivery|postage|p&p)',
  '\\b(?:discount|promo|coupon|voucher)\\s*code', '\\buse\\s+(?:the\\s+)?code', '\\bcode\\s*[:\\-]?\\s*[A-Z0-9]{3,}',
  '\\b2\\s?(?:for|4)\\s?1\\b', 'two\\s+for\\s+one', 'buy\\s+(?:one|1)\\s*,?\\s*get\\s+(?:one|1)', '\\bbogo(?:f)?\\b',
  '\\b3\\s?(?:for|4)\\s?2\\b', 'half\\s+price', 'black\\s+friday', 'cyber\\s+monday', '\\bsale\\b',
].join('|'), 'i');

const NOISE_RE = /^(sale|sale price|regular price|unit price|sold out|on sale|sale!?)$|cookie|privacy policy|^©|subscribe to our newsletter$/i;

/** Pulls short banner-like lines of text that look like promotions. */
function extractPromoLines_(html) {
  let s = String(html)
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|a|h[1-6]|section|header|button|td)>/gi, '\n')
    .replace(/<(div|p|li|h[1-6]|section|header|ul|ol|tr)(?=[\s>])/gi, '\n<$1')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities_(s);
  const seen = {}, out = [];
  s.split(/\n+/).forEach(line => {
    line = line.replace(/\s+/g, ' ').trim();
    if (line.length < 6 || line.length > 220) return;
    if (NOISE_RE.test(line) || !PROMO_RE.test(line)) return;
    const key = line.toLowerCase().replace(/[^a-z0-9%£]/g, '');
    if (seen[key]) return;
    seen[key] = 1;
    out.push(line);
  });
  return out.slice(0, 25);
}

function decodeEntities_(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(n) ? m : String.fromCharCode(n); }
    return map[e.toLowerCase()] !== undefined ? map[e.toLowerCase()] : m;
  });
}

const CODE_STOPWORDS = /^(AT|THE|AND|FOR|YOUR|CHECKOUT|BELOW|ABOVE|HERE|NOW|TODAY|IS|TO|ON|OFF|WITH|CODE|USE|ENTER|APPLY|APPLIED|AUTOMATICALLY|ALL|ORDERS?|FREE|SALE|UK|GBP|NEW|SHOP|WHEN|ONLY|THIS|THAT|FIRST|ORDER)$/;

/** Parses one promo line into structured signals. */
function parsePromo_(line, now) {
  now = now || new Date();
  const p = { text: line, code: '', percentOff: null, amountOff: null, freeShipping: false,
    shippingThreshold: null, minSpend: null, twoForOne: false, multibuy: '', expires: '', subscription: false, newsletter: false, firstOrder: false, sitewideSale: false };

  // Discount code — must look like a code (caps/digits) not an English word
  const codeRes = [
    /(?:code|coupon|voucher|promo)\s*[:\-–]?\s*["'“‘]?([A-Za-z0-9][A-Za-z0-9_\-]{2,19})["'”’]?/g,
    /\buse\s+["'“‘]([A-Za-z0-9_\-]{3,20})["'”’]/gi,
    /\buse\s+([A-Z0-9][A-Z0-9_\-]{2,19})\b/g,
  ];
  for (let i = 0; i < codeRes.length && !p.code; i++) {
    let m; codeRes[i].lastIndex = 0;
    while ((m = codeRes[i].exec(line))) {
      const c = m[1];
      const looksLikeCode = (c === c.toUpperCase() && /[A-Z]/.test(c)) || /\d/.test(c) && /[A-Za-z]/.test(c);
      if (looksLikeCode && !CODE_STOPWORDS.test(c.toUpperCase())) { p.code = c.toUpperCase(); break; }
    }
  }

  let m = line.match(/(\d{1,2})\s?%\s?(?:off|discount|saving)/i) || line.match(/save\s+(?:up\s+to\s+)?(\d{1,2})\s?%/i);
  if (m) p.percentOff = +m[1];
  m = line.match(/£\s?(\d+(?:\.\d\d)?)\s+off/i) || line.match(/save\s+£\s?(\d+(?:\.\d\d)?)/i);
  if (m) p.amountOff = +m[1];

  if (/free\s+(?:(?:uk|mainland|standard|tracked|next[- ]day|royal\s+mail)\s+)*(?:shipping|delivery|postage|p&p)/i.test(line)) {
    p.freeShipping = true;
    m = line.match(/(?:over|above|orders?\s+of|spend(?:ing)?|when you spend)\s+£\s?(\d+(?:\.\d\d)?)/i);
    if (m) p.shippingThreshold = +m[1];
  }
  if (/\b2\s?(?:for|4)\s?1\b|two\s+for\s+one|buy\s+(?:one|1)\s*,?\s*get\s+(?:one|1)(?:\s+free)?|\bbogof?\b/i.test(line)) p.twoForOne = true;
  m = line.match(/\b(\d)\s?(?:for|4)\s?(\d)\b/);
  if (m && +m[1] > +m[2]) p.multibuy = m[1] + ' for ' + m[2];
  if (/half\s+price/i.test(line) && !p.percentOff) p.percentOff = 50;
  // Newsletter / email sign-up offers (the code is usually emailed, not shown)
  if (/newsletter|mailing\s+list|e-?mail\s+list|our\s+e-?mails|sign\s*up\s+(?:for|to)\s+(?:our\s+)?(?:e-?mails|updates|news)|sign\s*up\s+(?:and|&|to\s+get|for\s+\d)|join\s+(?:our|the)\s+(?:list|club|community|newsletter)/i.test(line)) p.newsletter = true;
  // Coffee subscriptions (not "subscribe to our newsletter")
  if (/subscri(?:be|ption)/i.test(line) && !p.newsletter) p.subscription = true;
  if (/first\s+(?:order|purchase|bag|box)|new\s+customers?/i.test(line)) p.firstOrder = true;
  m = line.match(/(?:over|above|spend(?:ing)?|orders?\s+(?:of|over|above)|min(?:imum)?\s+(?:spend|order)(?:\s+of)?)\s+£\s?(\d+(?:\.\d\d)?)/i);
  if (m) p.minSpend = +m[1];
  if (/\bsale\b/i.test(line) && (p.percentOff || /up to/i.test(line))) p.sitewideSale = true;

  p.expires = parseExpiry_(line, now);
  return p;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Finds "ends Sunday", "until 30th November", "valid till 30/11", "ends midnight" … → ISO string or ''. */
function parseExpiry_(line, now) {
  const m = line.match(/(?:ends?|ending|until|till|expires?|expiring|valid\s+(?:until|till|to|through)|runs?\s+(?:until|till|to)|offer\s+closes|closes|before|last\s+day)\s*:?\s+(?:at\s+)?(?:midnight\s+)?(?:on\s+)?(?:this\s+)?([^.!;|]{2,40})/i);
  if (!m) return /\b(today only|ends tonight|ends today)\b/i.test(line) ? endOfDay_(now).toISOString() : '';
  const d = parseUkDate_(m[1], now);
  return d ? d.toISOString() : '';
}

function parseUkDate_(s, now) {
  s = String(s).toLowerCase();
  const year = now.getFullYear();
  let m, d = null;
  const monRe = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  if ((m = s.match(new RegExp('(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + monRe + '(?:,?\\s+(\\d{4}))?')))) {
    d = new Date(m[3] ? +m[3] : year, MONTHS[m[2].slice(0, 3)], +m[1]);
  } else if ((m = s.match(new RegExp(monRe + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?')))) {
    d = new Date(m[3] ? +m[3] : year, MONTHS[m[1].slice(0, 3)], +m[2]);
  } else if ((m = s.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/))) {
    let y = m[3] ? +m[3] : year; if (y < 100) y += 2000;
    if (+m[2] >= 1 && +m[2] <= 12) d = new Date(y, +m[2] - 1, +m[1]);
  } else if ((m = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/))) {
    d = new Date(now); const diff = (DAYS[m[1]] - now.getDay() + 7) % 7; d.setDate(now.getDate() + diff);
  } else if (/\btomorrow\b/.test(s)) {
    d = new Date(now); d.setDate(now.getDate() + 1);
  } else if (/\b(tonight|today|midnight)\b/.test(s)) {
    d = new Date(now);
  }
  if (!d || isNaN(d)) return null;
  // No explicit year and well in the past → assume next year (e.g. "until 5th Jan" said in December)
  if (!/\d{4}/.test(s) && d < new Date(now.getTime() - 60 * 864e5)) d.setFullYear(d.getFullYear() + 1);
  return endOfDay_(d);
}

function endOfDay_(d) { const x = new Date(d); x.setHours(23, 59, 59, 0); return x; }

/** "250g", "1kg", "2 x 250g", "1 kilo" → grams (null if none / implausible). */
function weightFromText_(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|kilo|g)\b/);
  let g = null;
  if (m) g = +m[1] * (+m[2]) * (m[3] === 'g' ? 1 : 1000);
  else if ((m = s.match(/(\d+(?:\.\d+)?)\s*(kg|kilo|kilogram|g|gram|grams)\b/))) g = +m[1] * (/^k/.test(m[2]) ? 1000 : 1);
  return g && g >= 50 && g <= 6000 ? g : null;
}

// ── Product classification ───────────────────────────────────────────
const SKIP_RE = /gift\s*card|gift\s*voucher|e-?voucher|donation|\bdeposit\b/i;
const EQUIPMENT_RE = /grinder|kettle|dripper|filter\s+papers?|\bpapers\b|\bv60\b|aeropress|chemex|kalita|origami|\bscales?\b|espresso\s+machine|coffee\s+machine|\bmachine\b|\bbrewer\b|cafeti[eè]re|french\s+press|moka|portafilter|tamper|distributor|knock\s*box|milk\s+(?:jug|pitcher)|\bjug\b|carafe|\bserver\b|cold\s+brew\s+(?:maker|kit|jar)|equipment|brewing\s+(?:kit|gear)|hario|fellow|timemore|comandante|baratza|wilfa|1zpresso|bialetti|clever\s+dripper|refractometer/i;
const OTHER_RE = /merch|t-?shirt|hoodie|sweat|tote|\bmug\b|\bcups?\b|keep\s*cup|tumbler|apron|\bcap\b|beanie|\bhat\b|sock|chocolate|\btea\b|matcha|chai|book|course|class|workshop|cleaning|descal|cleaner|syrup|capsules?|pods?\b|nespresso|candle|sticker|poster|print|gift\s*box|hamper|biscuit|cookie|sample\s*pack|tasting\s+kit/i;
const COFFEE_TYPE_RE = /coffee|beans?|espresso|filter|single\s+origin|blend|decaf|roast/i;

/** 'coffee' | 'equipment' | 'other' | null (skip). Product type and title decide, never grind options. */
function classifyProduct_(title, type, tags, grams) {
  const text = [title, type].join(' ');
  if (SKIP_RE.test(text)) return null;
  const coffeeType = COFFEE_TYPE_RE.test(type || '') && !/equipment|accessor|merch|gift/i.test(type || '');
  if (EQUIPMENT_RE.test(text) && !coffeeType) return 'equipment';
  if (OTHER_RE.test(text) && !coffeeType) return 'other';
  if (grams || coffeeType || /\bcoffee\b|type:coffee/i.test(tags || '')) return 'coffee';
  return 'other';
}

/** 'espresso' | 'filter' | 'omni' | '' from title, product type, tags and handle — never the grind dropdown. */
function roastFromText_(text) {
  const s = String(text || '').toLowerCase();
  if (/\bomni\b|omni-?roast|all[- ]rounder/.test(s)) return 'omni';
  const esp = /espresso/.test(s), fil = /\bfilter\b|pour[- ]?over|light\s+roast|\bv60\b|batch\s+brew/.test(s);
  return esp && fil ? 'omni' : esp ? 'espresso' : fil ? 'filter' : '';
}

/** Category of a banner promo from its wording; 'all' when it's site-wide. */
function promoCategory_(line) {
  if (/\b(?:beans?|coffees?|espresso|filter\s+roasts?|single\s+origins?|blends?|decaf|bags?)\b/i.test(line)) return 'coffee';
  if (EQUIPMENT_RE.test(line)) return 'equipment';
  return 'all';
}

/**
 * Shopify /products.json → one row per in-stock coffee variant:
 * {title, variant, productUrl, url (deep-links the exact variant), image, price, compareAt, grams, ppg, percentOff}
 */
function parseShopifyProducts_(json, base) {
  const out = [];
  (json.products || []).forEach(p => {
    const tags = Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || '');
    const img = p.images && p.images[0] ? p.images[0].src : '';
    const productUrl = base + '/products/' + p.handle;
    const roast = roastFromText_([p.title, p.product_type, tags, p.handle].join(' '));
    const rows = [];
    (p.variants || []).forEach(v => {
      if (v.available === false) return;
      const price = parseFloat(v.price), cmp = parseFloat(v.compare_at_price) || 0;
      let grams = weightFromText_(v.title) || weightFromText_(p.title);
      const category = classifyProduct_(p.title, p.product_type, tags, grams);
      if (!category || !price) return;
      if (category === 'coffee' && !grams && v.grams >= 100 && v.grams <= 6000) grams = roundWeight_(v.grams);
      if (category === 'coffee' && !grams) return;          // can't compare a coffee without its bag size
      if (category !== 'coffee') grams = null;
      rows.push({
        title: p.title, category: category, roast: category === 'coffee' ? roast : '',
        variant: grams ? fmtWeight_(grams) : (v.title && v.title !== 'Default Title' ? v.title : ''),
        productUrl: productUrl, url: productUrl + (v.id ? '?variant=' + v.id : ''), image: img,
        price: price, rawCompareAt: cmp, grams: grams, ppg: grams ? round2_(price * 100 / grams) : null,
      });
    });
    const trusted = compareAtIsCredible_(rows);
    rows.forEach(r => {
      const ok = trusted && r.rawCompareAt > r.price;
      r.compareAt = ok ? r.rawCompareAt : null;
      r.percentOff = ok ? Math.round((1 - r.price / r.rawCompareAt) * 100) : 0;
      if (r.percentOff > CONFIG.MAX_SALE_PERCENT) { r.compareAt = null; r.percentOff = 0; }
      out.push(r);
    });
  });
  return out;
}

/**
 * Shops often fill compare_at_price with junk: one product-level "was" price copied
 * onto every bag size, or a "was" price lower than the current price. Only trust it
 * when it behaves like a real per-size "was" price.
 */
function compareAtIsCredible_(rows) {
  const withCmp = rows.filter(r => r.rawCompareAt > 0);
  if (!withCmp.length) return false;
  // Any variant whose "was" price is below what it costs now → the field isn't a sale price.
  if (withCmp.some(r => r.rawCompareAt < r.price)) return false;
  // The same "was" price on different bag sizes (e.g. £17 on 125g, 220g, 500g and 1kg) → copied, not a sale.
  const weightsByCmp = {};
  withCmp.forEach(r => { (weightsByCmp[r.rawCompareAt] = weightsByCmp[r.rawCompareAt] || {})[r.grams] = 1; });
  if (Object.keys(weightsByCmp).some(c => Object.keys(weightsByCmp[c]).length > 1)) return false;
  return true;
}

function fmtWeight_(g) { return g >= 1000 ? (g / 1000) + 'kg' : g + 'g'; }

/** Shopify "grams" often includes packaging (e.g. 270 for a 250g bag) — snap to common sizes. */
function roundWeight_(g) {
  const sizes = [100, 150, 200, 225, 227, 250, 300, 340, 350, 400, 454, 500, 750, 1000, 2000, 2500, 3000, 5000];
  let best = null;
  sizes.forEach(s => { if (g >= s && g <= s * 1.15 && (!best || s > best)) best = s; });
  return best || g;
}

/** WooCommerce Store API → same shape as Shopify parser. */
function parseWooProducts_(json) {
  const out = [];
  (Array.isArray(json) ? json : []).forEach(p => {
    const name = decodeEntities_(p.name || '');
    const cats = (p.categories || []).map(c => c.name).join(' '), tags = (p.tags || []).map(t => t.name).join(' ');
    const pr = p.prices || {}, unit = Math.pow(10, pr.currency_minor_unit || 2);
    const price = +pr.price / unit, reg = +pr.regular_price / unit;
    let grams = weightFromText_(name) || weightFromText_(p.short_description);
    const category = classifyProduct_(name, cats, tags, grams);
    if (!category || !price) return;
    if (category === 'coffee' && !grams) return;
    if (category !== 'coffee') grams = null;
    let pct = reg > price ? Math.round((1 - price / reg) * 100) : 0;
    if (pct > CONFIG.MAX_SALE_PERCENT) pct = 0;
    out.push({
      title: name, category: category, roast: category === 'coffee' ? roastFromText_([name, cats, tags, p.slug].join(' ')) : '',
      variant: grams ? fmtWeight_(grams) : '', productUrl: p.permalink, url: p.permalink, image: p.images && p.images[0] ? p.images[0].src : '',
      price: price, compareAt: pct ? reg : null, grams: grams, ppg: grams ? round2_(price * 100 / grams) : null, percentOff: pct,
    });
  });
  return out;
}

/** Combines promo lines + product feed into deal rows. */
function buildDeals_(r) {
  const brand = r.brand.name, deals = [], now = new Date();
  const ppgs = r.products.filter(p => p.category === 'coffee').map(p => p.ppg).filter(Boolean);
  r.bestPricePerGram = ppgs.length ? Math.min.apply(null, ppgs) : null;

  // Free shipping is a fact about the roaster, not a deal you click into — attach it to every deal they have.
  r.shippingNote = '';
  r.promos.forEach(line => {
    const p = parsePromo_(line, now);
    if (!p.freeShipping || p.code) return;
    const note = p.shippingThreshold ? 'Free shipping over £' + p.shippingThreshold : 'Free shipping';
    if (!r.shippingNote || (p.shippingThreshold && (!r.shipMin || p.shippingThreshold < r.shipMin))) { r.shippingNote = note; r.shipMin = p.shippingThreshold || 0; }
  });

  // 1) Banner / announcement promos
  r.promos.forEach(line => {
    const p = parsePromo_(line, now);
    const tags = [];
    if (p.freeShipping) tags.push('free-shipping');
    if (p.twoForOne) tags.push('2-for-1');
    if (p.multibuy) tags.push('multibuy');
    if (p.code) tags.push('code');
    if (p.percentOff || p.amountOff) tags.push('sale');
    if (p.subscription) tags.push('subscription');
    if (p.newsletter) tags.push('newsletter');
    if (p.firstOrder) tags.push('first-order');
    // Must be actionable: a code, a number, free shipping or a multibuy.
    if (!(p.code || p.percentOff || p.amountOff || p.freeShipping || p.twoForOne || p.multibuy)) return;

    const type = p.twoForOne || p.multibuy ? 'multibuy' : p.code ? 'code' : (p.percentOff || p.amountOff) ? 'sale' : 'shipping';
    const discountText = p.twoForOne ? '2 for 1' : p.multibuy ? p.multibuy
      : p.percentOff ? p.percentOff + '% off' : p.amountOff ? '£' + p.amountOff + ' off'
      : p.freeShipping ? (p.shippingThreshold ? 'Free shipping over £' + p.shippingThreshold : 'Free shipping') : '';
    let ppg = r.bestPricePerGram;
    if (ppg && p.percentOff) ppg = round2_(ppg * (1 - p.percentOff / 100));
    if (ppg && p.twoForOne) ppg = round2_(ppg / 2);
    const method = promoMethod_(p);
    // Free-shipping-only banners become the roaster's shipping note (above), not a deal card.
    if (type === 'shipping' && !p.code) return;
    // Code-less banner offers can only be checked at checkout — skipped unless switched on.
    if (method === 'automatic' && !CONFIG.INCLUDE_CHECKOUT_DEALS) return;
    const category = promoCategory_(line);
    if (category === 'equipment') ppg = null;                 // price per gram only means something for coffee
    deals.push({
      id: hash_(brand + '|' + type + '|' + p.code + '|' + line.toLowerCase().replace(/[^a-z0-9]/g, '')),
      brand: brand, type: type, title: line.slice(0, 160), discountText: discountText,
      percentOff: p.percentOff || '', code: p.code, expires: p.expires, tags: addPpgTag_(tags, ppg).join(','),
      pricePerGram: ppg || '', url: r.base, image: '', sourceText: line,
      method: method, minSpend: p.minSpend || '',
      howTo: howToText_(method, { code: p.code, minSpend: p.minSpend, firstOrder: p.firstOrder, multibuy: p.twoForOne || !!p.multibuy, freeShippingOnly: type === 'shipping' }),
      category: category, roast: category === 'equipment' ? '' : (roastFromText_(line) || 'all'),
    });
  });

  // 2) Product-level sale prices (best variant per product), capped per category
  const byProduct = {};
  r.products.filter(p => p.compareAt && p.percentOff >= CONFIG.MIN_SALE_PERCENT).forEach(p => {
    const cur = byProduct[p.productUrl];
    if (!cur || p.percentOff > cur.percentOff || (p.percentOff === cur.percentOff && (p.ppg || 0) < (cur.ppg || 0))) byProduct[p.productUrl] = p;
  });
  const perCat = {};
  Object.keys(byProduct).map(k => byProduct[k])
    .sort((a, b) => b.percentOff - a.percentOff)
    .forEach(p => {
      perCat[p.category] = (perCat[p.category] || 0) + 1;
      if (perCat[p.category] > CONFIG.MAX_SALE_DEALS_PER_BRAND) return;
      const isCoffee = p.category === 'coffee';
      deals.push({
        id: hash_(brand + '|sale|' + p.url), brand: brand, type: 'sale',
        title: p.title + (isCoffee ? ' — ' + p.variant + ' bag' : p.variant ? ' — ' + p.variant : ''),
        discountText: p.percentOff + '% off · £' + p.price.toFixed(2) + (isCoffee ? ' for ' + p.variant : '') + ' (was £' + p.compareAt.toFixed(2) + ')',
        percentOff: p.percentOff, code: '', expires: '', tags: addPpgTag_(['sale'], p.ppg).join(','),
        pricePerGram: p.ppg || '', url: p.url, image: p.image, sourceText: 'products feed',
        method: 'automatic', minSpend: '', howTo: howToText_('automatic', { productSale: true, size: isCoffee ? p.variant : '' }),
        category: p.category, roast: p.roast || '',
      });
    });

  // Attach the roaster's free-shipping note to everything they have on offer.
  if (r.shippingNote) deals.forEach(d => {
    d.shippingNote = r.shippingNote;
    if (d.tags.split(',').indexOf('free-shipping') < 0) d.tags = d.tags ? d.tags + ',free-shipping' : 'free-shipping';
  });
  return deals;
}

/** Newsletter beats code (a code in a sign-up banner is usually the emailed one); then code; then subscription; else automatic. */
function promoMethod_(p) {
  if (p.newsletter) return 'newsletter';
  if (p.code) return 'code';
  if (p.subscription) return 'subscription';
  return 'automatic';
}

/** Plain-English "how to get it" line shown on every deal card. */
function howToText_(method, o) {
  o = o || {};
  let s;
  if (method === 'code') s = 'Enter code ' + (o.code || 'shown') + ' at checkout.';
  else if (method === 'newsletter') s = o.code ? 'Sign up to their newsletter on the roaster\'s site to unlock code ' + o.code + '.' : 'Sign up to their newsletter on the roaster\'s site. The code is emailed to you.';
  else if (method === 'subscription') s = 'Start a coffee subscription on the roaster\'s site. The discount applies to subscription orders.';
  else if (o.productSale) s = 'Already reduced on the roaster\'s site' + (o.size ? ' (' + o.size + ' bag)' : '') + '. No code needed. The button opens that exact product.';
  else if (o.multibuy) s = 'Add the bags to your basket. No code is shown, so the discount should apply at checkout.';
  else if (o.freeShippingOnly) { s = (o.minSpend ? 'Spend £' + o.minSpend + ' or more and free' : 'Free') + ' shipping is applied at checkout. No code needed.'; o = Object.assign({}, o, { minSpend: null }); }
  else s = 'No code is shown on their site, so the discount should apply at checkout.';
  const extra = [];
  if (o.minSpend) extra.push('Minimum spend £' + o.minSpend + '.');
  if (o.firstOrder) extra.push('First order only.');
  return [s].concat(extra).join(' ');
}

function addPpgTag_(tags, ppg) {
  if (!ppg) return tags;
  tags.push(ppg < 4 ? 'ppg-under-4' : ppg < 6 ? 'ppg-4-6' : ppg < 8 ? 'ppg-6-8' : 'ppg-8-plus');
  return tags;
}

// robots.txt — minimal parser for "User-agent: *" (and our bot name)
function parseRobots_(txt) {
  const rules = []; let applies = false, sawAgent = false, delay = 0;
  String(txt).split(/\r?\n/).forEach(raw => {
    const line = raw.replace(/#.*/, '').trim(); if (!line) return;
    const idx = line.indexOf(':'); if (idx < 0) return;
    const k = line.slice(0, idx).trim().toLowerCase(), v = line.slice(idx + 1).trim();
    if (k === 'user-agent') {
      if (!sawAgent) applies = false;
      sawAgent = true;
      if (v === '*' || /getmorecoffee/i.test(v)) applies = true;
    } else {
      sawAgent = false;
      if (applies && (k === 'disallow' || k === 'allow') && v) rules.push({ allow: k === 'allow', path: v });
      if (applies && k === 'crawl-delay' && !isNaN(parseFloat(v))) delay = Math.max(delay, parseFloat(v));
    }
  });
  return { rules: rules, delay: delay };
}

function isAllowed_(rules, path) {
  let best = null;
  (rules || []).forEach(r => {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  });
  return !best || best.allow;
}

// ───────────────────────────── PERSISTENCE ────────────────────────────
function saveResults_(results) {
  const ss = getSS_(), now = new Date();
  const dealSheet = ss.getSheetByName(SHEETS.DEALS);
  const existing = readObjects_(SHEETS.DEALS);
  const prev = {};
  existing.forEach(d => { prev[d.id] = d; });
  const scraped = {};
  results.forEach(r => { if (r.status.indexOf('ok') === 0) scraped[r.brand.name] = true; });

  // Keep rows for brands we did NOT successfully scrape this round.
  const keep = existing.filter(d => !scraped[d.brand]);
  results.forEach(r => {
    if (!scraped[r.brand.name]) return;
    r.deals.forEach(d => {
      const old = prev[d.id];
      d.firstSeen = old && old.firstSeen ? old.firstSeen : now;
      d.lastSeen = now;
      d.hidden = old ? old.hidden : false;
      keep.push(d);
    });
  });

  dealSheet.getRange(1, 1, 1, DEAL_HEADERS.length).setValues([DEAL_HEADERS]);
  const rows = keep.map(d => DEAL_HEADERS.map(h => (d[h] === undefined || d[h] === null) ? '' : d[h]));
  dealSheet.getRange(2, 1, Math.max(dealSheet.getLastRow() - 1, 1), DEAL_HEADERS.length).clearContent();
  if (rows.length) dealSheet.getRange(2, 1, rows.length, DEAL_HEADERS.length).setValues(rows);

  // Update brand status columns
  const bSheet = ss.getSheetByName(SHEETS.BRANDS);
  const col = h => BRAND_HEADERS.indexOf(h) + 1;
  results.forEach(r => {
    const row = r.brand._row;
    let fails = +r.brand.failCount || 0, until = '';
    if (r.blocked) {
      fails += 1;
      const days = CONFIG.BACKOFF_DAYS[Math.min(fails, CONFIG.BACKOFF_DAYS.length) - 1];
      let t = new Date(now.getTime() + days * 864e5);
      if (r.retryAfter && r.retryAfter > t) t = r.retryAfter;
      until = t;
      r.status += ' — backing off until ' + Utilities.formatDate(t, 'Europe/London', 'd MMM');
    } else if (r.status.indexOf('ok') === 0) {
      fails = 0;
    }
    bSheet.getRange(row, col('platform'), 1, 7).setValues([[
      r.platform || r.brand.platform || '', now, r.status, r.deals.length, r.bestPricePerGram || r.brand.bestPricePerGram || '', fails, until]]);
    if (r.status.indexOf('ok') === 0) bSheet.getRange(row, col('shipping')).setValue(r.shippingNote || '');
    if (r.status.indexOf('ok') !== 0) log_(r.brand.name, r.blocked ? 'block' : 'warn', r.status);
  });
}

// ─────────────────────────────── HELPERS ──────────────────────────────
function getSS_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) { props.setProperty('SHEET_ID', active.getId()); return active; }
  const ss = SpreadsheetApp.create('Get More Coffee — Data');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold')
    .setBackground('#D64541').setFontColor('#F4EDE1');
  sh.setFrozenRows(1);
  return sh;
}

function readObjects_(sheetName) {
  const sh = getSS_().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values.map((row, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { o[h] = row[j]; });
    return o;
  }).filter(o => headers.some(h => o[h] !== ''));
}

function readBrands_() {
  return readObjects_(SHEETS.BRANDS).filter(b => b.name).map(b => {
    b.active = truthy_(b.active);
    return b;
  });
}

function log_(brand, level, msg) {
  try {
    const sh = getSS_().getSheetByName(SHEETS.LOG);
    if (!sh) return;
    sh.appendRow([new Date(), brand, level, msg]);
    if (sh.getLastRow() > 2000) sh.deleteRows(2, 500);
  } catch (e) { console.log(brand, level, msg); }
}

function cacheGet_(key) {
  const c = CacheService.getScriptCache();
  const n = +c.get(key + ':n'); if (!n) return null;
  const parts = c.getAll(Array.from({ length: n }, (_, i) => key + ':' + i));
  let s = '';
  for (let i = 0; i < n; i++) { if (parts[key + ':' + i] == null) return null; s += parts[key + ':' + i]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function cachePut_(key, obj) {
  const s = JSON.stringify(obj), size = 90000, chunks = {};
  const n = Math.ceil(s.length / size);
  for (let i = 0; i < n; i++) chunks[key + ':' + i] = s.substr(i * size, size);
  chunks[key + ':n'] = String(n);
  try { CacheService.getScriptCache().putAll(chunks, CONFIG.CACHE_SECONDS); } catch (e) { /* too big — skip cache */ }
}

function baseUrl_(url) { const m = String(url).trim().match(/^(https?:\/\/[^\/?#]+)/i); return m ? m[1] : String(url).replace(/\/+$/, ''); }
function hoursSince_(d) { return d ? (Date.now() - new Date(d).getTime()) / 36e5 : Infinity; }
function truthy_(v) { return v === true || /^(true|yes|y|1|x)$/i.test(String(v).trim()); }
function num_(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function round2_(n) { return Math.round(n * 100) / 100; }
function splitTags_(t) { return String(t || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s);
  return bytes.slice(0, 6).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
