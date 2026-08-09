-- Core ingest schema.
--
-- Only what P1 actually uses. Enrichment, embeddings, tag vocabulary and
-- clusters arrive with the phases that need them; the embedding table in
-- particular cannot be written yet because pgvector fixes the dimension at
-- column definition time and the model is not chosen until then.

-- Single-user today. The column exists so that adding accounts later is a
-- migration rather than a rewrite of every query; it costs one column now.
CREATE TABLE users (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default');

CREATE TABLE sources (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Which implementation handles this subscription. The pipeline never
  -- branches on this beyond choosing a Source; see packages/core/src/source.ts.
  kind     text NOT NULL CHECK (kind IN ('feed', 'external', 'rule', 'plugin')),
  url      text NOT NULL,
  title    text,
  site_url text,
  -- Implementation-specific settings, validated by the implementation.
  config   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 'unsupported' is distinct from 'degraded': nothing is broken, a component
  -- the source needs (a headless browser, an AI provider) is simply not
  -- installed. Reporting that as a failure would send people debugging
  -- something that is working as configured.
  status   text NOT NULL DEFAULT 'active'
           CHECK (status IN ('active', 'degraded', 'unsupported', 'disabled')),

  -- Change detection. etag and last_modified drive conditional GET;
  -- content_hash is the fallback for the many servers that ignore it and
  -- return 200 with an identical body every time.
  etag          text,
  last_modified text,
  content_hash  text,

  fetch_interval_seconds integer NOT NULL DEFAULT 3600
                         CHECK (fetch_interval_seconds >= 60),
  next_fetch_at          timestamptz NOT NULL DEFAULT now(),
  last_fetched_at        timestamptz,
  last_success_at        timestamptz,
  consecutive_failures   integer NOT NULL DEFAULT 0,
  last_error             text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, url)
);

-- The scheduler's only query: which subscriptions are due right now.
CREATE INDEX sources_due ON sources (next_fetch_at) WHERE status IN ('active', 'degraded');

-- Items are global, keyed by the canonical URL hash rather than scoped to a
-- source. With a couple of hundred subscriptions the same article genuinely
-- does arrive through several of them, and read state has to be per article:
-- having read something once, you should not meet it again from another feed.
CREATE TABLE items (
  id            text PRIMARY KEY,
  url           text NOT NULL,
  canonical_url text NOT NULL,
  title         text,
  author        text,
  -- Recorded for debugging only. Identity comes from the URL, because feeds
  -- that mutate their own guid on every fetch are common enough to matter.
  guid          text,

  published_at           timestamptz NOT NULL,
  -- True when published_at is fetch time because the source gave no usable
  -- date. Ranking must not treat a guess as breaking news.
  published_at_estimated boolean NOT NULL DEFAULT false,

  content_html text,
  summary      text,
  -- Plain text used for full-text search, derived from title and body.
  search_text  text NOT NULL DEFAULT '',
  -- Object storage key for the retained original HTML, null when retention is
  -- off or the window has passed.
  raw_html_key text,

  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX items_published_at ON items (published_at DESC);

-- Which subscriptions delivered a given item. Many-to-many because a global
-- item can arrive from several sources.
CREATE TABLE item_sources (
  item_id       text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, source_id)
);

CREATE INDEX item_sources_by_source ON item_sources (source_id, first_seen_at DESC);

-- Current per-user state for an item.
--
-- Deliberately a state row rather than an append-only event log: the only
-- consumer that would benefit from repeated events is interest scoring, and it
-- needs "when did this happen" rather than "how many times", which the
-- timestamps already answer.
CREATE TABLE item_state (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id    text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  read_at    timestamptz,
  starred_at timestamptz,
  skipped_at timestamptz,
  saved_at   timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

-- Reading the timeline means "items with no read_at", so index the exception.
CREATE INDEX item_state_read ON item_state (user_id, item_id) WHERE read_at IS NOT NULL;
CREATE INDEX item_state_starred ON item_state (user_id, starred_at DESC) WHERE starred_at IS NOT NULL;
