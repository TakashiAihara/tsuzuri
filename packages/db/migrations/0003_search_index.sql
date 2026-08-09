-- Full-text search index.
--
-- pgroonga rather than a tsvector index because tsvector's tokenizer does not
-- segment Japanese: "機械学習の論文" is one token to it, so searching for
-- "機械学習" finds nothing. pgroonga handles CJK segmentation and gives a
-- usable relevance score, which P2 combines with vector similarity.

CREATE INDEX items_search_text_pgroonga ON items USING pgroonga (search_text);
