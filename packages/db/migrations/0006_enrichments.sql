-- LLM enrichment: summaries, translations and tags.
--
-- One row per (item, kind, prompt version, model), which makes replay
-- additive. Changing a prompt and re-running over yesterday's articles writes
-- new rows beside the old ones, so the two versions can be compared without
-- refetching anything and without losing what the previous prompt said. An
-- upsert keyed on (item, kind) alone would make every prompt change
-- destructive and every comparison impossible.
CREATE TABLE enrichments (
  item_id        text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('summary', 'translation', 'tags')),
  content        jsonb NOT NULL,
  chat_model     text NOT NULL,
  prompt_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind, prompt_version, chat_model)
);

-- Readers ask "the newest enrichment of this kind for this item", so index the
-- lookup rather than the primary key's leading columns alone.
CREATE INDEX enrichments_by_item_kind ON enrichments (item_id, kind, created_at DESC);

-- Items the enrichment worker has failed on, mirroring embedding_failures.
--
-- Without this a single article the model refuses -- one that trips a content
-- filter, one whose text is pathological -- is selected on every pass and
-- blocks the queue behind it forever.
CREATE TABLE enrichment_failures (
  item_id         text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  failures        integer NOT NULL DEFAULT 1 CHECK (failures > 0),
  last_error      text,
  next_attempt_at timestamptz NOT NULL,
  PRIMARY KEY (item_id, kind)
);

CREATE INDEX enrichment_failures_next_attempt ON enrichment_failures (next_attempt_at);

-- The closed set of tags a model may choose from.
--
-- Starts empty on purpose: the first few dozen articles propose candidates,
-- and a human approves the ones worth keeping. Seeding a vocabulary would
-- impose someone else's taxonomy on every install.
--
-- `hits` counts how often the model has proposed a candidate, which is the
-- only evidence available for whether it is worth approving. A tag rejected
-- and re-proposed comes back as a fresh candidate; that is deliberate, since
-- persistent re-proposal is itself an argument for the tag.
CREATE TABLE tag_vocabulary (
  tag        text PRIMARY KEY,
  status     text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved')),
  hits       integer NOT NULL DEFAULT 1 CHECK (hits > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tag_vocabulary_candidates ON tag_vocabulary (hits DESC) WHERE status = 'candidate';

-- Only approved tags reach this table; candidates are not tags yet.
CREATE TABLE item_tags (
  item_id text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag     text NOT NULL REFERENCES tag_vocabulary (tag) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag)
);

CREATE INDEX item_tags_by_tag ON item_tags (tag, item_id);
