-- The loader's ledger: which storage objects have been applied to PostgreSQL.
--
-- The loader lists items/*.parquet, skips every key recorded here, and marks
-- each object it applies in the same transaction as its rows. Truncating the
-- table makes it apply everything again, which is what `tsuzuri rebuild`
-- does. The items themselves are never deleted by a rebuild: they insert ON
-- CONFLICT DO NOTHING, and item_state -- which is not in storage yet --
-- references them with ON DELETE CASCADE.
CREATE TABLE loaded_objects (
  key       text PRIMARY KEY,
  rows      integer NOT NULL CHECK (rows >= 0),
  rejected  integer NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  loaded_at timestamptz NOT NULL DEFAULT now()
);
