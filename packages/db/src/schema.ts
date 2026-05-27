import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  vector,
  primaryKey,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Data model (PRD §12). Core runs single-user with one implicit space;
// the same schema supports multi-tenant for the Cloud edition.

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  provider: text('provider'), // 'google' | 'microsoft' | 'local'
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const spaces = pgTable('spaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Permission unit: being a member = full access to the space (PRD §7.2).
export const memberships = pgTable(
  'memberships',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull().default('member'), // 'owner' | 'member'
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] })],
);

export const notes = pgTable('notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id),
  // Optional folder (null = space root). Deleting the folder cascade-deletes
  // its notes — matches user mental model ("trash a folder, everything inside
  // is gone"). To preserve notes, move them out first or use `folderId: null`
  // via PUT /notes/:id before deleting the folder.
  folderId: uuid('folder_id').references((): AnyPgColumn => folders.id, {
    onDelete: 'cascade',
  }),
  title: text('title').notNull(),
  contentMd: text('content_md').notNull().default(''),
  favorite: boolean('favorite').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Chunks for semantic search (PRD §8). Short notes = 1 whole chunk.
// 1536 dims = indexable limit for Azure + reduced text-embedding-3-large.
// spaceId is denormalised so we can filter by tenant without a join (avoids
// the pgvector foot-gun where vector queries cross tenant boundaries).
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    position: integer('position').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (t) => [
    index('chunks_space_idx').on(t.spaceId),
    // Keyword search (BM25/FTS) in Spanish content.
    index('chunks_fts_idx').using('gin', sql`to_tsvector('spanish', ${t.text})`),
    // Vector search (cosine). Azure swaps this for DiskANN.
    index('chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// Per-user access tokens (used by Claude/Copilot to connect via MCP).
// Only the HASH is stored, never the cleartext token.
export const tokens = pgTable('tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  name: text('name').notNull().default('token'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Tags (#tag) derived from content at index time. Stored lowercase.
export const noteTags = pgTable(
  'note_tags',
  {
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.tag] }),
    index('note_tags_space_tag_idx').on(t.spaceId, t.tag),
  ],
);

// Outgoing links (wikilinks) derived at index time. `target` = destination title lowercase.
// Powers backlinks and the graph view.
export const noteLinks = pgTable(
  'note_links',
  {
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.target] }),
    index('note_links_space_target_idx').on(t.spaceId, t.target),
  ],
);

// Hierarchical folder tree per space. A folder groups notes.
// Self-ref parent_id allows sub-folders. Deleting a folder cascade-deletes
// its sub-folders AND its notes (see notes.folder_id FK).
export const folders = pgTable('folders', {
  id: uuid('id').defaultRandom().primaryKey(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => folders.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
