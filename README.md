# Get More Coffee: Apps Script prototype

![Desktop preview](docs/preview-desktop.png)

A deals site for UK specialty coffee. A Google Sheet holds the data, Apps Script scrapes the roasters once a day, and the same project serves the website.

## Files

| File | What it does |
|---|---|
| `Code.gs` | Scraper, Sheet "database", JSON API, web app (`doGet`) |
| `Brands.gs` | Starter list of 152 UK specialty roasters (copied into the Sheet on setup) |
| `Index.html` | The site: branding, filters, deal cards, roaster directory |
| `appsscript.json` | Manifest: London timezone, V8, public web app |

## Set up (about 10 minutes)

1. Create a new Google Sheet called **Get More Coffee — Data**, then go to **Extensions → Apps Script**.
2. Rename `Code.gs` and paste in `Code.gs`. Add a script file called `Brands` and paste in `Brands.gs`. Add an HTML file called `Index` and paste in `Index.html`.
3. Go to **Project Settings**, tick *Show "appsscript.json"*, then paste in the manifest.
4. Select `setup` in the function dropdown, click **Run**, and approve the permissions. This creates the tabs and seeds the roasters. **Daily scraping is paused for now** (`AUTO_SCRAPE: false` in `CONFIG`), and running `setup` removes any daily trigger already installed. To switch it back on, set `AUTO_SCRAPE: true` and run `setup` again.
5. Reload the Sheet. Open the **☕ Get More Coffee** menu and choose **Scrape now**. That checks every active roaster straight away, keeping to the rate limits and back-offs. A full pass of 152 roasters takes about 8–10 minutes. Apps Script stops each run after 6 minutes, so the scraper automatically schedules a follow-up 15 minutes later to finish the rest.
6. Check the `status` column on the **Brands** tab. Fix any wrong URLs, and untick `active` for roasters you don't want.
7. Go to **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. The `/exec` URL is your live site.

## How the scraper finds deals

Each roaster is visited once a day.

### Rate limits

All of these are set in `CONFIG` at the top of `Code.gs`:

| Setting | Value | Why |
|---|---|---|
| Daily run | 03:00–04:00 UK time | Quiet hours for the roasters. Apps Script picks a random minute within the hour. |
| Requests per roaster | About 2 a day (homepage and product feed) | Plus `robots.txt` once a week. |
| `BATCH_SIZE` | 5 | Only different roasters are fetched at the same time, never two requests to one site at once. |
| `MIN_GAP_SAME_SITE_MS` | 5 s | The minimum gap between our two requests to one roaster. |
| `robots.txt` | Respected and cached for 7 days | Disallowed pages are skipped. A `Crawl-delay` of up to 30 s is respected; above that, the product feed is skipped. |
| `BACKOFF_DAYS` | 1 → 2 → 4 → 7 → 14 | After a 403, 429 or 503, that roaster is left alone, for longer each time. A `Retry-After` header is respected if it asks for longer. |

The Brands tab shows `failCount` and `backoffUntil` for each roaster. **☕ Get More Coffee → Clear all back-offs** resets them.

A one-off follow-up 15 minutes later still finishes any scrape you start that runs past Apps Script's 6-minute limit. It never repeats on its own.

If a roaster blocks the bot repeatedly, add its deals through Manual Deals or ask them for an affiliate feed. Don't try to get around the block.

- **Homepage banners** are parsed for codes (`use code BEANS20`), % or £ off, free shipping and its threshold, 2-for-1, BOGOF, 3-for-2, subscription and first-order offers, and end dates (`ends Sunday`, `until 30th November`, `valid till 30/11`).
- **Shopify stores** (most UK roasters) are read through `/products.json`. That gives sale prices (where `compare_at_price` is higher than `price`) and bag weight, which is used for **price per gram**.
- **WooCommerce stores** are read through the Store API in the same way.
- Squarespace, Wix and custom sites get banner parsing only.

Price-per-gram tags: `ppg-under-4`, `ppg-4-6`, `ppg-6-8`, `ppg-8-plus` (pence per gram). For a site-wide % code, the price per gram is the roaster's cheapest bag after the discount. For a 2-for-1, it's that price halved.

### How to get it

Every deal shows how to claim it, and shoppers can filter by it:

| Method | When | What the card says |
|---|---|---|
| Promo code | A code appears in the banner | "Enter code BF25 at checkout." |
| Newsletter sign-up | The banner mentions a newsletter or mailing list | "Sign up to their newsletter… the code is emailed to you." |
| Subscription | The offer is for subscribing | "Start a coffee subscription…" |
| No code needed | Sale prices, multibuys and free shipping with no code shown | "Already reduced…" or "…applied at checkout." |

Extra conditions are added to the end of the line: "First order only." and "Minimum spend £X."

### Categories, roast and what's left out

- **Category tabs:** Coffee (the default), Equipment and Other. Products are sorted by product type and title, for example grinders, drippers and kettles go under Equipment, and mugs, chocolate and merch under Other. Gift cards are skipped. Site-wide codes appear on every tab.
- **Roast filter (Coffee tab only):** Espresso or Filter. The roast is read from the product's title, type, tags and web address, never from the grind dropdown. Omni roasts and site-wide codes match both.
- **Free shipping** is shown as a note on each of that roaster's deals, for example "Free shipping over £30". It no longer gets its own card.
- **Offers you can only check at checkout,** meaning banner offers with no code such as "2 for 1 this weekend" or "15% off everything", are left out for now. Set `INCLUDE_CHECKOUT_DEALS: true` in `CONFIG` to bring them back.

## Running it day to day

- **Bad or false-positive deal:** tick `hidden` on that row in **Deals**. The setting is kept on later scrapes.
- **Deals you find yourself, or from affiliate networks:** add them to **Manual Deals**. Set `method` to `code`, `automatic`, `newsletter` or `subscription`, `category` to `coffee`, `equipment`, `other` or `all`, and optionally `roast` to `espresso`, `filter` or `omni`. You can also add your own `howTo` line and a `minSpend`; otherwise the line is written for you. These get a "Verified" label and rank higher.
- **Affiliate links:** put the tracking parameter (for example `ref=getmore`) in the Brands `affiliateParam` column. Every outbound link already includes `utm_source=getmore.coffee`, so roasters can see the traffic you send them. That's useful when you pitch them on affiliate deals.
- **Deal lifecycle:** expired deals disappear automatically. Deals not seen for 3 days are dropped.

## Pointing getmore.coffee at it

Apps Script can't serve a custom domain directly, and on a free Gmail account Google adds a small "created by an Apps Script user" bar. Your options:

1. **Recommended:** host `Index.html` on Vercel or Cloudflare Pages at getmore.coffee. Add this line in `<head>`:
   `<script>window.GMC_API = 'https://script.google.com/macros/s/XXXX/exec?format=json';</script>`
   The page then fetches live data from Apps Script, with no banner and full SEO control.
2. **Quickest:** embed the `/exec` URL in a Google Site and connect the domain there.

## Known limits of the prototype

- Banners loaded by JavaScript apps after the page loads aren't in the raw HTML, so the scraper can't see them. Add those deals through Manual Deals.
- Some roasters block bots (HTTP 403) or use Cloudflare. The `status` column shows which ones.
- Expiry dates are only shown when the roaster publishes one.
- The roaster list is a strong starting point, not a complete census. Add new roasters as rows on the Brands tab.

## Syncing with Apps Script (optional)

Instead of copying and pasting each file into the Apps Script editor, you can push them from this repo with [clasp](https://github.com/google/clasp):

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # then paste your script ID (Apps Script → Project Settings)
clasp push
```

`.clasp.json` holds your script ID, so it's git-ignored. `.claspignore` makes sure only the four Apps Script files are uploaded.
