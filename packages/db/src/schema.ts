import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  vector,
  primaryKey,
} from 'drizzle-orm/pg-core';

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
export const chunks = pgTable('chunks', {
  id: uuid('id').defaultRandom().primaryKey(),
  notaId: uuid('nota_id')
    .notNull()
    .references(() => notas.id, { onDelete: 'cascade' }),
  texto: text('texto').notNull(),
  orden: integer('orden').notNull().default(0),
  embedding: vector('embedding', { dimensions: 1536 }),
});
