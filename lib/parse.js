/**
 * More Coffee — parsing and deal-building (pure functions, no I/O).
 * Ported 1:1 from the Apps Script version so behaviour stays identical.
 */
import { createHash } from 'node:crypto';
import { CONFIG } from './config.js';

// ── small helpers ──
export function round2_(n) { return Math.round(n * 100) / 100; }
export function num_(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
export function splitTags_(t) { return String(t || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
export function baseUrl_(url) { const m = String(url).trim().match(/^(https?:\/\/[^\/?#]+)/i); return m ? m[1] : String(url).replace(/\/+$/, ''); }
export function hash_(s) { return createHash('md5').update(String(s)).digest('hex').slice(0, 12); }

// ───────────────────────── PARSING (pure functions) ────────────────────
/** Shopify pages expose the active currency, e.g. Shopify.currency = {"active":"GBP","rate":"1.0"}. */
export function detectCurrency_(html) {
  const m = String(html).match(/Shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/);
  return m ? m[1] : '';
}

export function detectPlatform_(html) {
  if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html)) return 'shopify';
  if (/woocommerce|wp-content\/plugins\/woo/i.test(html)) return 'woocommerce';
  if (/static1\.squarespace\.com|squarespace-cdn/i.test(html)) return 'squarespace';
  if (/wixstatic\.com|wix\.com/i.test(html)) return 'wix';
  if (/bigcommerce/i.test(html)) return 'bigcommerce';
  return 'other';
}

export const PROMO_RE = new RegExp([
  '\\d{1,2}\\s?%\\s?off', 'save\\s+(?:up\\s+to\\s+)?(?:£\\d|\\d{1,2}\\s?%)', '£\\d+(?:\\.\\d\\d)?\\s+off',
  'free\\s+(?:(?:uk|mainland|standard|tracked|next[- ]day|royal\\s+mail)\\s+)*(?:shipping|delivery|postage|p&p)',
  '\\b(?:discount|promo|coupon|voucher)\\s*code', '\\buse\\s+(?:the\\s+)?code', '\\bcode\\s*[:\\-]?\\s*[A-Z0-9]{3,}',
  '\\b2\\s?(?:for|4)\\s?1\\b', 'two\\s+for\\s+one', 'buy\\s+(?:one|1)\\s*,?\\s*get\\s+(?:one|1)', '\\bbogo(?:f)?\\b',
  '\\b3\\s?(?:for|4)\\s?2\\b', 'half\\s+price', 'black\\s+friday', 'cyber\\s+monday', '\\bsale\\b',
].join('|'), 'i');

export const NOISE_RE = /^(sale|sale price|regular price|unit price|sold out|on sale|sale!?)$|cookie|privacy policy|^©|subscribe to our newsletter$/i;

/** Pulls short banner-like lines of text that look like promotions. */
export function extractPromoLines_(html) {
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

export function decodeEntities_(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(n) ? m : String.fromCharCode(n); }
    return map[e.toLowerCase()] !== undefined ? map[e.toLowerCase()] : m;
  });
}

export const CODE_STOPWORDS = /^(AT|THE|AND|FOR|YOUR|CHECKOUT|BELOW|ABOVE|HERE|NOW|TODAY|IS|TO|ON|OFF|WITH|CODE|USE|ENTER|APPLY|APPLIED|AUTOMATICALLY|ALL|ORDERS?|FREE|SALE|UK|GBP|NEW|SHOP|WHEN|ONLY|THIS|THAT|FIRST|ORDER)$/;

/** Parses one promo line into structured signals. */
export function parsePromo_(line, now) {
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

export const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Finds "ends Sunday", "until 30th November", "valid till 30/11", "ends midnight" … → ISO string or ''. */
export function parseExpiry_(line, now) {
  const m = line.match(/(?:ended|ends?|ending|until|till|expires?|expiring|valid\s+(?:until|till|to|through)|runs?\s+(?:until|till|to)|offer\s+closes|closes|before|last\s+day)\s*:?\s+(?:at\s+)?(?:midnight\s+)?(?:on\s+)?(?:this\s+)?([^.!;|]{2,40})/i);
  if (!m) return /\b(today only|ends tonight|ends today)\b/i.test(line) ? endOfDay_(now).toISOString() : '';
  const d = parseUkDate_(m[1], now);
  return d ? d.toISOString() : '';
}

export function parseUkDate_(s, now) {
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

export function endOfDay_(d) { const x = new Date(d); x.setHours(23, 59, 59, 0); return x; }

/** "250g", "1kg", "2 x 250g", "1 kilo" → grams (null if none / implausible). */
export function weightFromText_(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|kilo|g)\b/);
  let g = null;
  if (m) g = +m[1] * (+m[2]) * (m[3] === 'g' ? 1 : 1000);
  else if ((m = s.match(/(\d+(?:\.\d+)?)\s*(kg|kilo|kilogram|g|gram|grams)\b/))) g = +m[1] * (/^k/.test(m[2]) ? 1000 : 1);
  return g && g >= 50 && g <= 6000 ? g : null;
}

// ── Product classification ───────────────────────────────────────────
export const SKIP_RE = /gift\s*card|gift\s*voucher|e-?voucher|donation|\bdeposit\b/i;
export const EQUIPMENT_RE = /grinder|kettle|dripper|filter\s+papers?|paper\s+filters?|\bfilters\b|\bpapers\b|\bv60\b|aeropress|chemex|kalita|origami|\bscales?\b|espresso\s+machine|coffee\s+machine|\bmachine\b|\bbrewer\b|cafeti[eè]re|french\s+press|moka|portafilter|tamper|distributor|\bwdt\b|puck\s*screen|dosing\s*cup|shower\s*screen|\bbasket\b|knock\s*box|milk\s+(?:jug|pitcher)|steam(?:ing)?\s+pitcher|frother|thermometer|\bjug\b|carafe|decanter|\bserver\b|cold\s+brew\s+(?:maker|kit|jar)|equipment|brewing\s+(?:kit|gear|set)|hario|fellow|stagg|gooseneck|timemore|comandante|baratza|wilfa|1zpresso|kingrinder|\bdf\s?(?:54|64|83)\b|niche\s+zero|eureka|mazzer|mahlk[oö]nig|\bek43\b|bialetti|clever\s+dripper|refractometer|acaia|brewista|kinto|loveramics|notneutral|\borea\b|april\s+brewer|cafec|moccamaster|technivorm|\bode\b|\bopus\b|\bencore\b|\bvaria\b|\bflair\b|cafelat|rhinowares|pullman|normcore|espro|bodum|la\s+marzocco|lelit|rocket\s+espresso|\bsage\b|breville|gaggia|rancilio|\bdecent\b/i;
export const EQUIP_TYPE_RE = /equipment|brew(?:ing)?\s*(?:gear|kit|tools?|equipment|accessor)|accessor|hardware|grinders?|kettles?|\bscales?\b|machines?|brewers?|drippers?|filter\s*papers?|\bpapers?\b|servers?|glassware|homeware/i;
export const OTHER_RE = /merch|t-?shirt|hoodie|sweat|tote|\bmug\b|\bcups?\b|keep\s*cup|tumbler|apron|\bcap\b|beanie|\bhat\b|sock|chocolate|\btea\b|matcha|chai|book|course|class|workshop|cleaning|descal|cleaner|syrup|capsules?|pods?\b|nespresso|candle|sticker|poster|print|gift\s*box|hamper|biscuit|cookie|sample\s*pack|tasting\s+kit/i;
// Product *type* must essentially BE coffee (so "Espresso machine" or "Filter papers" never count).
export const COFFEE_TYPE_RE = /^(?:coffees?|beans?|coffee\s*beans?|whole\s*beans?|ground\s*coffee|roasted\s*coffee|single\s*origins?|blends?|espresso(?:\s*(?:beans?|blends?|roasts?|coffee))?|filter(?:\s*(?:coffee|roasts?|beans?))?|decaf(?:feinated)?(?:\s*coffee)?|seasonal(?:\s*coffee)?|limited(?:\s*(?:release|edition))?|micro-?lots?|coffee\s*-\s*.+)$/i;

/**
 * 'coffee' | 'equipment' | 'other' | null (skip). Uses product type, tags and title —
 * never the grind dropdown. Order matters: explicit equipment signals win, then an
 * explicit coffee product type, then title words, then "has a bag weight" = coffee.
 */
export function classifyProduct_(title, type, tags, grams) {
  const t = String(type || '').trim(), tg = String(tags || ''), name = String(title || '');
  if (SKIP_RE.test(name + ' ' + t)) return null;
  if (EQUIP_TYPE_RE.test(t) || /(?:^|[\s,])(?:equipment|brewing|brew\s*gear|hardware|accessories|grinders?)(?:$|[\s,])/i.test(tg)) return 'equipment';
  if (COFFEE_TYPE_RE.test(t) || /type:\s*coffee|coffee\s*beans/i.test(tg)) return 'coffee';
  if (EQUIPMENT_RE.test(name)) return 'equipment';
  if (OTHER_RE.test(name + ' ' + t)) return 'other';
  if (grams) return 'coffee';
  return 'other';
}

/** 'espresso' | 'filter' | 'omni' | '' from title, product type, tags and handle — never the grind dropdown. */
export function roastFromText_(text) {
  const s = String(text || '').toLowerCase();
  if (/\bomni\b|omni-?roast|all[- ]rounder/.test(s)) return 'omni';
  const esp = /espresso/.test(s), fil = /\bfilter\b|pour[- ]?over|light\s+roast|\bv60\b|batch\s+brew/.test(s);
  return esp && fil ? 'omni' : esp ? 'espresso' : fil ? 'filter' : '';
}

/** Category of a banner promo from its wording; 'all' when it's site-wide. */
export function promoCategory_(line) {
  if (/\b(?:beans?|coffees?|espresso|filter\s+roasts?|single\s+origins?|blends?|decaf|bags?)\b/i.test(line)) return 'coffee';
  if (EQUIPMENT_RE.test(line)) return 'equipment';
  return 'all';
}

/**
 * Shopify /products.json → one row per in-stock coffee variant:
 * {title, variant, productUrl, url (deep-links the exact variant), image, price, compareAt, grams, ppg, percentOff}
 */
export function parseShopifyProducts_(json, base) {
  const out = [];
  (json.products || []).forEach(p => {
    const tags = Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || '');
    const img = p.images && p.images[0] ? p.images[0].src : '';
    const productUrl = base + '/products/' + p.handle;
    const roast = roastFromText_([p.title, p.product_type, tags, p.handle].join(' '));
    const audienceText = [p.title, p.product_type, tags, p.handle].join(' ');
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
        audience: audienceTags_(audienceText + ' ' + (v.title || ''), grams),
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
export function compareAtIsCredible_(rows) {
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

export function fmtWeight_(g) { return g >= 1000 ? (g / 1000) + 'kg' : g + 'g'; }

/** Shopify "grams" often includes packaging (e.g. 270 for a 250g bag) — snap to common sizes. */
export function roundWeight_(g) {
  const sizes = [100, 150, 200, 225, 227, 250, 300, 340, 350, 400, 454, 500, 750, 1000, 2000, 2500, 3000, 5000];
  let best = null;
  sizes.forEach(s => { if (g >= s && g <= s * 1.15 && (!best || s > best)) best = s; });
  return best || g;
}

/** WooCommerce Store API → same shape as Shopify parser. */
export function parseWooProducts_(json) {
  const out = [];
  (Array.isArray(json) ? json : []).forEach(p => {
    const name = decodeEntities_(p.name || '');
    const cats = (p.categories || []).map(c => c.name).join(' '), tags = (p.tags || []).map(t => t.name).join(' ');
    const pr = p.prices || {}, unit = Math.pow(10, pr.currency_minor_unit || 2);
    if (pr.currency_code && pr.currency_code !== 'GBP') return;   // pounds only
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
      audience: audienceTags_([name, cats, tags, p.slug].join(' '), grams),
    });
  });
  return out;
}

// Who a product or offer is really for. Used by the site's "Hide" filters.
export const SUBSCRIPTION_RE = /subscri(?:be|ption)|coffee\s+club|membership|\bevery\s+(?:week|month|\d+\s+weeks)\b|recurring/i;
export const OFFICE_RE = /\boffices?\b|wholesale|workplace|catering|commercial|(?<!fair[\s-])\btrade\b|for\s+(?:business|cafes|cafés)|\bbulk\b|caf[eé]\s+supply/i;
export function audienceTags_(text, grams) {
  const t = String(text || ''), out = [];
  if (SUBSCRIPTION_RE.test(t)) out.push('subscription');
  if (OFFICE_RE.test(t)) out.push('office');
  if (grams && grams >= 2000) out.push('bulk');               // 2kg+ bags are rarely bought for home
  return out;
}

/** Combines promo lines + product feed into deal rows. */
export function buildDeals_(r) {
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
    if (OFFICE_RE.test(line)) tags.push('office');
    // Already over (e.g. "ended Sunday" still on the banner): skip it.
    if (p.expires && new Date(p.expires) < now) return;
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
      id: promoId_(brand, type, method, p),
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
        id: hash_(brand + '|sale|' + p.productUrl), brand: brand, type: 'sale',
        title: p.title + (isCoffee ? ' — ' + p.variant + ' bag' : p.variant ? ' — ' + p.variant : ''),
        discountText: p.percentOff + '% off · £' + p.price.toFixed(2) + (isCoffee ? ' for ' + p.variant : '') + ' (was £' + p.compareAt.toFixed(2) + ')',
        percentOff: p.percentOff, code: '', expires: '', tags: addPpgTag_(['sale'].concat(p.audience || []), p.ppg).join(','),
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
  // The same offer often appears in several banners (header bar, pop-up, footer): keep one.
  const seen = {};
  return deals.filter(d => (seen[d.id] ? false : (seen[d.id] = true)));
}

/**
 * A promo's id comes from what the offer IS (roaster, code, size of discount, how you get it),
 * not the exact banner wording, so a reworded banner isn't counted as a new deal.
 */
export function promoId_(brand, type, method, p) {
  return hash_([brand.toLowerCase(), type, method, p.code || '', p.percentOff || '', p.amountOff || '',
    p.twoForOne ? '2for1' : '', p.multibuy || '', p.code ? '' : (p.minSpend || '')].join('|'));
}

/** Newsletter beats code (a code in a sign-up banner is usually the emailed one); then code; then subscription; else automatic. */
export function promoMethod_(p) {
  if (p.newsletter) return 'newsletter';
  if (p.code) return 'code';
  if (p.subscription) return 'subscription';
  return 'automatic';
}

/** Plain-English "how to get it" line shown on every deal card. */
export function howToText_(method, o) {
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

export function addPpgTag_(tags, ppg) {
  if (!ppg || !CONFIG.SHOW_PRICE_PER_GRAM) return tags;
  tags.push(ppg < 4 ? 'ppg-under-4' : ppg < 6 ? 'ppg-4-6' : ppg < 8 ? 'ppg-6-8' : 'ppg-8-plus');
  return tags;
}

// robots.txt — minimal parser for "User-agent: *" (and our bot name)
export function parseRobots_(txt) {
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

export function isAllowed_(rules, path) {
  let best = null;
  (rules || []).forEach(r => {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  });
  return !best || best.allow;
}

