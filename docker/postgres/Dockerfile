# PGroonga (Japanese/multilingual full-text search) + pgvector (embeddings)
# in one image. No public image ships both, so we add pgvector on top of the
# official PGroonga image, which is itself built on the PGDG postgres image.
FROM groonga/pgroonga:4.0.8-debian-18

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-18-pgvector \
    && rm -rf /var/lib/apt/lists/*
