import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  vector,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Modelo de datos del PRD §12.
// En Core hay un único usuario y un espacio implícito; el mismo esquema
// soporta multiusuario para la edición Cloud.

export const usuarios = pgTable('usuarios', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  proveedor: text('proveedor'), // 'google' | 'microsoft' | 'local'
  creado: timestamp('creado').defaultNow().notNull(),
});

export const espacios = pgTable('espacios', {
  id: uuid('id').defaultRandom().primaryKey(),
  nombre: text('nombre').notNull(),
  duenoId: uuid('dueno_id')
    .notNull()
    .references(() => usuarios.id),
  creado: timestamp('creado').defaultNow().notNull(),
});

// Unidad de permisos: ser miembro = acceso total al espacio (PRD §7.2).
export const miembros = pgTable(
  'miembros',
  {
    espacioId: uuid('espacio_id')
      .notNull()
      .references(() => espacios.id),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id),
    rol: text('rol').notNull().default('member'), // 'owner' | 'member'
  },
  (t) => [primaryKey({ columns: [t.espacioId, t.usuarioId] })],
);

export const notas = pgTable('notas', {
  id: uuid('id').defaultRandom().primaryKey(),
  espacioId: uuid('espacio_id')
    .notNull()
    .references(() => espacios.id),
  titulo: text('titulo').notNull(),
  contenidoMd: text('contenido_md').notNull().default(''),
  creado: timestamp('creado').defaultNow().notNull(),
  modificado: timestamp('modificado').defaultNow().notNull(),
});

// Chunks para búsqueda semántica (PRD §8). Notas cortas = 1 chunk entero.
// 1536 dims = límite indexable de Azure + text-embedding-3-large reducido.
// espacioId denormalizado: filtrar por espacio sin join (evita el foot-gun de
// pgvector al filtrar por inquilino).
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    notaId: uuid('nota_id')
      .notNull()
      .references(() => notas.id, { onDelete: 'cascade' }),
    espacioId: uuid('espacio_id')
      .notNull()
      .references(() => espacios.id, { onDelete: 'cascade' }),
    texto: text('texto').notNull(),
    orden: integer('orden').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (t) => [
    index('chunks_espacio_idx').on(t.espacioId),
    // Búsqueda por palabra (BM25/FTS) en español.
    index('chunks_fts_idx').using('gin', sql`to_tsvector('spanish', ${t.texto})`),
    // Búsqueda vectorial (coseno). En Azure se reemplaza por DiskANN.
    index('chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);
