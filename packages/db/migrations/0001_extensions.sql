-- Required extensions.
--
-- Both are hard dependencies, not optional accelerators:
--   pgroonga  full-text search that actually segments Japanese. The built-in
--             tsvector tokenizer splits on whitespace, which makes it useless
--             for CJK. pg_bigm and pg_trgm were considered and rejected: three
--             search backends would mean tuning hybrid ranking three times.
--   vector    embedding storage and ANN search for relevance scoring.
--
-- This is why managed Postgres (RDS, Neon, Supabase) is not supported. Run the
-- image in docker/postgres, which ships both.

CREATE EXTENSION IF NOT EXISTS pgroonga;
CREATE EXTENSION IF NOT EXISTS vector;
