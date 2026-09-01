-- A vector space has to know how to embed a query for itself.
--
-- Today the only place a provider's endpoint and key live is `embedding_config`,
-- which holds ONE row per organisation: the current choice. That is enough
-- while nothing changes, and wrong the moment something does — which is
-- exactly when it matters.
--
-- Measured on the shipped code, changing the model in Admin → AI:
--
--   · the moment the choice is saved, semantic search returns ZERO results —
--     the query is embedded with the new provider and asks the new, empty
--     partition, while the catalogue still calls the old model `active`;
--   · the reindex then re-embeds every note into the NEW partition and, since
--     replacing a note's chunks cascades to its vectors, DELETES the old ones.
--     The organisation is left with an `active` model whose partition is empty
--     and a `building` one that holds everything;
--   · `related` (the Neighbors panel) reads the model the catalogue calls
--     active, so it returns nothing even after the reindex finishes.
--
-- Two code paths disagreed about which model is live: search followed the
-- CONFIGURATION, `related` followed the CATALOGUE. ADR-003 says the catalogue
-- decides — build alongside, dual-write, atomic flip — and to serve a query
-- from the active space while another is being built, the process has to be
-- able to build the active model's provider. It cannot: the configuration row
-- that described it was overwritten by the new choice.
--
-- So the credential moves to where the thing that needs it lives. Each model
-- row carries the endpoint and the sealed key it was registered with; the
-- space knows how to embed for itself, and the pair dies with the partition
-- when the model is dropped.
--
-- Existing rows get NULL, which reads as "whatever the organisation's
-- configuration says" — the behaviour they have today, so this migration
-- changes nothing on its own.

ALTER TABLE embedding_models
  ADD COLUMN IF NOT EXISTS endpoint text;

-- Sealed with the same passphrase as `embedding_config.api_key_sealed`
-- (DILUXITE_SECRET_KEY). Never returned to a client: the admin console reads
-- the configuration, not the catalogue.
ALTER TABLE embedding_models
  ADD COLUMN IF NOT EXISTS api_key_sealed text;
