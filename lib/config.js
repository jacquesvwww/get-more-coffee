/**
 * More Coffee — settings. Anything that changes between environments comes from
 * environment variables (set them in Vercel → Project → Settings → Environment Variables).
 */
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

export const CONFIG = {
  SITE_URL: env('SITE_URL', 'https://getmore.coffee'),
  SHOW_PRICE_PER_GRAM: false,        // hidden on the site: it pushes "cheapest wins", which isn't what this is for
  MAX_SALE_PERCENT: 70,              // anything deeper is almost always bad shop data, not a real sale
  LOCALE_QUERY: '?country=GB&currency=GBP', // ask every shop for UK prices in pounds (Vercel runs outside the UK too)
  // Banner offers with no code ("2 for 1 this weekend") can't be checked until checkout. Off for now.
  INCLUDE_CHECKOUT_DEALS: false,
  USER_AGENT: 'Mozilla/5.0 (compatible; GetMoreCoffeeBot/0.2; +https://getmore.coffee/bot)',

  // ── Schedule ──
  AUTO_SCRAPE: env('AUTO_SCRAPE', 'false') === 'true', // daily scraping is PAUSED until you set AUTO_SCRAPE=true
  RESCRAPE_HOURS: 20,                // a roaster is never visited more than once per ~day
  // Time one function call may spend scraping. Keep it under the function's maxDuration in vercel.json.
  RUN_BUDGET_MS: Number(env('RUN_BUDGET_MS', 50000)),

  // ── Rate limits / politeness ──
  BATCH_SIZE: 5,                     // different roasters fetched side by side (never 2 at once to one site)
  PAUSE_BETWEEN_BATCHES_MS: 3000,
  MIN_GAP_SAME_SITE_MS: 5000,        // min gap between two requests to the same roaster
  MAX_CRAWL_DELAY_MS: 15000,         // honour robots.txt Crawl-delay up to this; above it we skip the product feed
  FETCH_TIMEOUT_MS: 15000,
  ROBOTS_CACHE_DAYS: 7,              // re-read robots.txt weekly, not daily
  BACKOFF_DAYS: [1, 2, 4, 7, 14],    // after a 403/429/503, leave the roaster alone this long (grows each time)
  STALE_DAYS: 3,                     // delete scraped deals not re-seen for this long
  DELETE_HIDDEN_AFTER_DAYS: 30,      // a deal you ticked "hidden" is remembered this long after it was last seen
  MAX_SALE_DEALS_PER_BRAND: 6,       // per category (coffee / equipment / other)
  MIN_SALE_PERCENT: 5,
  CACHE_SECONDS: 600,                // how long the CDN may cache /api/deals
  UTM: 'utm_source=getmore.coffee&utm_medium=referral&utm_campaign=deals',
};

/** How a shopper actually gets the discount. */
export const METHODS = {
  automatic: 'No code needed',
  code: 'Promo code',
  newsletter: 'Newsletter sign-up',
  subscription: 'Subscription',
};
