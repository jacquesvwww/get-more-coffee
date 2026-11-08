-- More Coffee — Postgres schema (Supabase, Neon or any Postgres).
-- Safe to run more than once. Either paste it into Supabase → SQL Editor and click Run,
-- or let /api/admin?action=setup run it for you.

CREATE TABLE IF NOT EXISTS brands (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  url              TEXT NOT NULL,
  city             TEXT,
  region           TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  affiliate_param  TEXT,                 -- e.g. ref=getmore (added to every outbound link)
  platform         TEXT,
  last_scraped     TIMESTAMPTZ,
  status           TEXT,
  deal_count       INTEGER NOT NULL DEFAULT 0,
  best_ppg         NUMERIC,              -- price per gram (kept internally, not shown)
  fail_count       INTEGER NOT NULL DEFAULT 0,
  backoff_until    TIMESTAMPTZ,
  shipping         TEXT                  -- e.g. "Free shipping over £30"
);

CREATE TABLE IF NOT EXISTS deals (
  id               TEXT PRIMARY KEY,
  brand            TEXT NOT NULL,
  type             TEXT,
  title            TEXT,
  discount_text    TEXT,
  percent_off      NUMERIC,
  code             TEXT,
  expires          TIMESTAMPTZ,
  tags             TEXT,
  price_per_gram   NUMERIC,
  url              TEXT,
  image            TEXT,
  source_text      TEXT,
  first_seen       TIMESTAMPTZ,
  last_seen        TIMESTAMPTZ,
  hidden           BOOLEAN NOT NULL DEFAULT FALSE,   -- tick to hide a bad/false-positive deal (kept on re-scrape)
  method           TEXT,
  how_to           TEXT,
  min_spend        NUMERIC,
  category         TEXT,
  roast            TEXT,
  shipping_note    TEXT
);
CREATE INDEX IF NOT EXISTS deals_brand_idx ON deals (brand);

CREATE TABLE IF NOT EXISTS manual_deals (
  id               SERIAL PRIMARY KEY,
  brand            TEXT NOT NULL,
  title            TEXT,
  discount_text    TEXT,
  percent_off      NUMERIC,
  code             TEXT,
  expires          TIMESTAMPTZ,
  tags             TEXT,
  url              TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT,
  method           TEXT,                 -- code | automatic | newsletter | subscription
  how_to           TEXT,
  min_spend        NUMERIC,
  category         TEXT DEFAULT 'coffee',-- coffee | equipment | other | all
  roast            TEXT                  -- espresso | filter | omni
);

CREATE TABLE IF NOT EXISTS robots_cache (
  base             TEXT PRIMARY KEY,
  rules            JSONB NOT NULL,
  delay            NUMERIC NOT NULL DEFAULT 0,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id               SERIAL PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  brand            TEXT,
  level            TEXT,
  message          TEXT
);

-- Supabase exposes tables in "public" through its auto-generated API. Turning on Row Level
-- Security with no policies blocks that API completely. The site's server connects as the
-- database owner, which isn't affected, so everything keeps working.
ALTER TABLE brands       ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE robots_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs         ENABLE ROW LEVEL SECURITY;
