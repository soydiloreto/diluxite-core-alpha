-- Un modelo de embeddings pertenece a una organización. Sin excepción.
--
-- 0031 agregó `org_id` a una tabla que ya tenía filas, así que no pudo
-- nacer NOT NULL: primero hay que rellenar, y las filas heredadas de 0027
-- no tenían organización que rellenar. Quedó nullable, y eso abre una
-- grieta concreta — el índice que garantiza "un modelo vivo por
-- organización" es `UNIQUE (org_id) WHERE state = 'active'`, y en Postgres
-- dos NULL son distintos entre sí. Una fila sin organización no viola nada
-- y puede haber muchas.
--
-- Ninguna consulta las alcanza (todas filtran por `org_id = $1`) y ninguna
-- es dueña de vectores: el slot de una partición se arma con el org_id
-- adelante, así que una fila sin organización no nombra ninguna partición.
-- Es dato muerto que además sostiene la grieta abierta.
DELETE FROM embedding_models WHERE org_id IS NULL;

ALTER TABLE embedding_models ALTER COLUMN org_id SET NOT NULL;
