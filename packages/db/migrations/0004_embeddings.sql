-- Embedding bookkeeping.
--
-- The vector table itself is NOT here. pgvector fixes the dimension in the
-- column definition, and the dimension is a property of an embedding model that
-- nobody has chosen yet at migration time -- the default is deliberately no
-- model at all. A column declared `vector` with no dimension is legal but
-- cannot carry an HNSW index ("column does not have dimensions"), so there is
-- no placeholder worth writing either.
--
-- item_embeddings is therefore created at runtime, once a model is configured
-- and its dimension probed. See packages/db/src/embeddings.ts.

-- The one embedding model this instance is using.
--
-- Single row: the `id boolean CHECK (id)` idiom makes a second row impossible
-- at the schema level rather than by convention. Two models cannot coexist,
-- because their vectors would share one column whose type belongs to exactly
-- one of them -- and even at matching dimensions the spaces are unrelated, so
-- distances between them would be meaningless.
CREATE TABLE embedding_model (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  provider   text NOT NULL,
  model      text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Items whose embedding call failed.
--
-- Backfill selects items that have no vector yet, so without this table a
-- single item the provider refuses -- one that is too long, or trips a content
-- filter -- would be selected again on every pass and block everything behind
-- it forever.
--
-- Not merged into item_embeddings as a nullable vector: a row there means "this
-- item is embedded", and a row that means "we tried and failed" would break
-- every count and every join that relies on it.
CREATE TABLE embedding_failures (
  item_id         text PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  failures        integer NOT NULL DEFAULT 1 CHECK (failures > 0),
  last_error      text,
  next_attempt_at timestamptz NOT NULL
);

CREATE INDEX embedding_failures_next_attempt ON embedding_failures (next_attempt_at);
