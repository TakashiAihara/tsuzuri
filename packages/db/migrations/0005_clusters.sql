-- Duplicate clusters: one row per story, not per copy of it.
--
-- Items are already global by canonical URL, but the same story republished by
-- ten outlets is ten different URLs. Membership is decided by the clustering
-- pass (SimHash proximity or embedding proximity to the representative); this
-- schema only records the outcome.
--
-- The representative is the earliest-published member. Deleting it cascades
-- the cluster away and nulls the members' cluster_id, which makes them
-- eligible for reassignment on the next pass -- deliberately self-healing
-- rather than re-electing in a trigger.
CREATE TABLE clusters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_item text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clusters_representative ON clusters (representative_item);

-- 64-bit SimHash over character trigrams of search_text. Computed at ingest,
-- with a backfill pass for items that predate this column. NULL means "not
-- hashed yet" or "text too short to hash"; both mean SimHash cannot vote.
ALTER TABLE items ADD COLUMN simhash bigint;

ALTER TABLE items ADD COLUMN cluster_id uuid REFERENCES clusters (id) ON DELETE SET NULL;

CREATE INDEX items_cluster ON items (cluster_id);

-- The clustering pass reads "items not yet assigned", so index the exception,
-- newest first -- the same shape as the unread index on item_state.
CREATE INDEX items_unclustered ON items (published_at DESC) WHERE cluster_id IS NULL;
