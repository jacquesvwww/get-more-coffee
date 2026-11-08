/**
 * More Coffee — the curated roaster list (independent specialty roasters, England & Wales).
 * /api/admin?action=setup seeds an empty database from this list. Later, use
 * /api/admin?action=sync-brands: it adds new roasters and switches off any
 * that are no longer here (nothing is deleted).
 * Columns: name, website, town/area, region
 */
export const BRANDS_SEED = [
  // ── London ──────────────────────────────────────────────
  ['Square Mile Coffee Roasters', 'https://shop.squaremilecoffee.com', 'London', 'London'],
  ['Workshop Coffee', 'https://workshopcoffee.com', 'London', 'London'],
  ['Climpson & Sons', 'https://climpsonandsons.com', 'London', 'London'],
  ['Ozone Coffee', 'https://ozonecoffee.co.uk', 'London', 'London'],
  ['Allpress Espresso UK', 'https://uk.allpressespresso.com', 'London', 'London'],
  ['Assembly Coffee', 'https://assemblycoffee.co.uk', 'London', 'London'],
  ['Monmouth Coffee Company', 'https://www.monmouthcoffee.co.uk', 'London', 'London'],
  ['Redemption Roasters', 'https://redemptionroasters.com', 'London', 'London'],
  ['Dark Arts Coffee', 'https://darkartscoffee.co.uk', 'London', 'London'],
  ['Kiss the Hippo', 'https://kissthehippo.com', 'London', 'London'],
  ['PLOT Roasting', 'https://plotroasting.com', 'London', 'London'],
  ['Scenery', 'https://scenery.coffee', 'London', 'London'],
  ['Catalyst', 'https://catalyst.coffee', 'London', 'London'],

  // ── South East ──────────────────────────────────────────
  ['Horsham Coffee Roaster', 'https://horshamcoffeeroaster.co.uk', 'West Sussex', 'South East'],

  // ── South West ──────────────────────────────────────────
  ['Colonna & Small\'s', 'https://colonnacoffee.com', 'Bath', 'South West'],
  ['Round Hill Roastery', 'https://roundhillroastery.com', 'Somerset', 'South West'],
  ['Rave Coffee', 'https://ravecoffee.co.uk', 'Cirencester', 'South West'],
  ['Ritual Coffee Roasters', 'https://ritualroasters.co.uk', 'Cheltenham', 'South West'],
  ['Girls Who Grind Coffee', 'https://girlswhogrindcoffee.com', 'Wiltshire', 'South West'],
  ['Clifton Coffee Roasters', 'https://cliftoncoffee.co.uk', 'Bristol', 'South West'],
  ['Extract Coffee Roasters', 'https://extractcoffee.co.uk', 'Bristol', 'South West'],
  ['Triple Co Roast', 'https://triplecoroast.com', 'Bristol', 'South West'],
  ['Crankhouse Coffee', 'https://crankhousecoffee.co.uk', 'Exeter', 'South West'],
  ['Origin Coffee Roasters', 'https://origincoffee.co.uk', 'Cornwall', 'South West'],
  ['Yallah Coffee', 'https://yallahcoffee.co.uk', 'Cornwall', 'South West'],

  // ── Midlands ────────────────────────────────────────────
  ['Hundred House Coffee', 'https://hundredhousecoffee.com', 'Shropshire', 'Midlands'],

  // ── Wales ───────────────────────────────────────────────
  ['Hard Lines', 'https://hard-lines.co.uk', 'Cardiff', 'Wales'],
  ['Quantum Coffee Roasters', 'https://quantumroasters.co.uk', 'Cardiff', 'Wales'],
  ['Heartland Coffee Roasters', 'https://heartland.coffee', 'Llandudno', 'Wales'],
  ['Coaltown Coffee', 'https://coaltowncoffee.co.uk', 'Ammanford', 'Wales'],

  // ── North West ──────────────────────────────────────────
  ['Neighbourhood Coffee', 'https://neighbourhoodcoffee.co.uk', 'Liverpool', 'North West'],
  ['Red Bank Coffee Roasters', 'https://redbankcoffee.com', 'Coniston, Cumbria', 'North West'],

  // ── Yorkshire & North East ──────────────────────────────
  ['North Star Coffee Roasters', 'https://northstarroast.com', 'Leeds', 'Yorkshire & North East'],
  ['Maude Coffee', 'https://maudecoffee.co.uk', 'Leeds', 'Yorkshire & North East'],
  ['KAPOW Coffee', 'https://kapowcoffee.co.uk', 'Leeds', 'Yorkshire & North East'],
  ['Dark Woods Coffee', 'https://www.darkwoods.coffee', 'West Yorkshire', 'Yorkshire & North East'],
];
