-- LLM enrichment: summaries, translations and tags, plus the tag vocabulary
-- they are chosen from.
--
-- The key carries model and prompt version, so a prompt change writes a new
-- row beside the old one instead of overwriting it. That is the whole of the
-- issue's completion criterion -- evaluating a new prompt against yesterday's
-- articles without refetching anything -- and it is a property of the key
-- rather than a feature built on top of one. Growth is bounded by an explicit
-- `tsuzuri enrich prune`, never automatically, because automatic pruning would
-- delete the comparison the key exists to make possible (D27).
--
-- Nothing here is written when no chat model is configured: enrichment is
-- optional, and ingest must not depend on it.

CREATE TABLE enrichments (
  item_id        text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('summary', 'translation', 'tags')),
  -- Target language for a translation; empty string otherwise, because a
  -- nullable column cannot carry a primary key.
  lang           text NOT NULL DEFAULT '',
  model          text NOT NULL,
  prompt_version text NOT NULL,
  content        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind, lang, model, prompt_version)
);

-- The hourly spend bound seeds itself from rows by when they were written, and
-- nothing reads enrichments by item any other way: the primary key already
-- leads with item_id, so an index on (item_id, kind) would only repeat it.
CREATE INDEX enrichments_by_created_at ON enrichments (created_at);

-- The tag observation count reads the current model's current tags rows for one
-- slug, and it is asked once per suggested slug, so without this the
-- vocabulary scans the table every time a model names something new.
CREATE INDEX enrichments_by_tags ON enrichments (model, prompt_version)
  WHERE kind = 'tags';

-- Items an enrichment call failed on, keyed by kind.
--
-- Selection picks items that have no row for the current model and prompt
-- version, so without this one article the model refuses -- one that trips a
-- content filter, one whose text is pathological -- is selected on every pass
-- and blocks everything behind it forever.
-- Keyed like enrichments, so a failure belongs to the model and prompt version
-- that produced it: switching models must not inherit the old model's backoff,
-- and two translation languages must not share one row.
CREATE TABLE enrichment_failures (
  item_id         text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('summary', 'translation', 'tags')),
  lang            text NOT NULL DEFAULT '',
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  failures        integer NOT NULL DEFAULT 1 CHECK (failures > 0),
  last_error      text,
  -- When the call was spent. next_attempt_at is computed from now and always
  -- lands in the future, so it cannot answer this, and the hourly spend bound
  -- has to count failures as well as successes.
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL,
  PRIMARY KEY (item_id, kind, lang, model, prompt_version)
);

CREATE INDEX enrichment_failures_by_attempt ON enrichment_failures (last_attempt_at);

-- The closed set of tags a model may choose from, split into approved and
-- candidate.
--
-- Starts empty on purpose (D28): seeding it would put one person's interests
-- into every installation. An empty vocabulary runs tagging in suggest-only
-- mode, which is the documented behaviour rather than a broken one.
CREATE TABLE tag_vocabulary (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  label        text NOT NULL,
  status       text NOT NULL DEFAULT 'candidate'
               CHECK (status IN ('approved', 'candidate', 'rejected')),
  -- How many distinct articles this build has named this candidate, counted
  -- from the tags enrichments rather than incremented. The promotion
  -- threshold.
  observations integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz
);

-- Only approved tags reach this table; a candidate is not a tag yet, and
-- attaching one would let the model widen the vocabulary by asking twice.
CREATE TABLE item_tags (
  item_id    text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tag_vocabulary (id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('model', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX item_tags_by_tag ON item_tags (tag_id);
