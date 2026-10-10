-- Duplicate clustering: one row per story rather than one per outlet.
--
-- Items are global by canonical URL, so byte-identical syndication is already
-- one item. What is left is the same story rewritten by several outlets, which
-- is a set of items with different URLs. See docs/design/p3-scoring-enrichment-
-- clustering-digest.md, Part 2.
--
-- Membership lives in its own table rather than as a column on items: ingest
-- owns items and enrichment must not write there. That separation is what
-- keeps the whole phase optional, and it costs one join.

CREATE TABLE clusters (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Earliest non-estimated published_at, ties broken by longest search_text
  -- (D23). Recomputed whenever a member joins, because items are not always
  -- clustered in publication order.
  representative_item_id text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  size                   integer NOT NULL DEFAULT 1 CHECK (size > 0),
  first_published_at     timestamptz NOT NULL,
  last_published_at      timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- An item belongs to at most one cluster, hence item_id as the key.
CREATE TABLE item_clusters (
  item_id    text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  -- Which signal joined this item to its cluster, for debugging a cluster that
  -- looks wrong. NULL for the member that founded the cluster: it matched
  -- nothing, and the clustering pass still needs a row for it so the item is
  -- not picked up as pending again.
  matched_by text CHECK (matched_by IN ('embedding', 'simhash', 'both')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX item_clusters_by_cluster ON item_clusters (cluster_id);

-- 64-bit SimHash of search_text. bit(64) rather than bigint: Hamming distance
-- is then bit_count(a # b) in SQL, and there is no sign bit to reinterpret.
-- No row means the text was too short to hash, in which case SimHash simply
-- does not vote for that item.
CREATE TABLE item_simhash (
  item_id   text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  simhash   bit(64) NOT NULL,
  hashed_at timestamptz NOT NULL DEFAULT now()
);
