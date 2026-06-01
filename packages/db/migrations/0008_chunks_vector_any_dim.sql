-- alpha.17 hotfix — soporte de embedders con dimension distinta a 1536.
--
-- El schema original fijó `chunks.embedding vector(1536)` por el modelo Azure
-- text-embedding-3-large. Pero el embedder Ollama por default (mxbai-embed-large)
-- retorna 1024 dims; usuarios que cambien de Azure a Ollama (o viceversa) o
-- arranquen con Ollama desde el inicio rompen el INSERT con
-- "expected 1536 dimensions, not 1024".
--
-- Fix: relajar la columna a `vector` sin dimension fija. pgvector lo permite
-- siempre que NO haya un índice HNSW/IVFFlat (esos exigen dim conocida en
-- tiempo de CREATE INDEX). Drop el índice también — para volúmenes de alpha
-- (~3000 chunks) la búsqueda secuencial todavía corre en <100ms. Re-crear
-- el índice apropiado se hace en un paso opt-in cuando el usuario decida
-- "este es mi embedder definitivo" (ver docs/RUNBOOK.md, próximo).
--
-- Conserva todos los embeddings existentes — las dims viejas (1536 desde el
-- seed) siguen viviendo en la columna junto con dims nuevas (1024 desde
-- Ollama). pgvector compara cosine solo cuando ambos vectores tienen la
-- misma dim; chunks de dim distinta simplemente no matchean entre sí, lo
-- cual es el comportamiento correcto (no son comparables).

DROP INDEX IF EXISTS chunks_embedding_idx;

ALTER TABLE chunks
  ALTER COLUMN embedding TYPE vector USING embedding::vector;
