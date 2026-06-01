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
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * pgvector column without a fixed dimension. Drizzle's built-in `vector`
 * requires a `dimensions` arg, but we deliberately want any dim (see the
 * `chunks.embedding` declaration below for why). The driver returns a
 * `number[]` and accepts a `number[]` on insert.
 */
const vectorAnyDim = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => {
    if (Array.isArray(value)) return value as number[];
    const s = (value as string).slice(1, -1);
    return s ? s.split(',').map(Number) : [];
  },
});

// Data model — three tiers of ownership / permissions (PRD §12 + v4.1 admin):
//
//   organization        — the company (e.g. "Acme Inc."). One per customer.
//                         Holds billing, branding, and the user roster.
//     org_memberships   — which users belong to the org and at what level:
//                           · super_admin: god mode (delete org, rename,
//                             change billing, promote/demote anyone).
//                           · admin: manage workspaces and members, can't
//                             touch billing or delete the org.
//                           · member: ordinary user; access to a workspace
//                             requires an explicit memberships row.
//     spaces            — a workspace (project / team / scope). Belongs to
//                         one org. Has its own folders, notes, tags, tokens.
//       memberships     — per-workspace ACL: admin | editor | viewer.
//                           · admin: can rename/delete the workspace and
//                             manage its members.
//                           · editor: read+write notes/folders.
//                           · viewer: read-only.
//
// Core runs a single bootstrapped "Local" org with one user (super_admin) and
// the historical default space. Cloud reuses the same model with Entra ID.

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Identity = email everywhere. Unique, lower-cased on write at the API.
  email: text('email').notNull().unique(),
  provider: text('provider'), // 'google' | 'microsoft' | 'local' | 'passkey'
  // Server-mode auth: PBKDF2 hash + salt as `pbkdf2$<iter>$<saltHex>$<hashHex>`.
  // Null for local-mode users (passwordless) and for users that only auth via
  // passkey (Fase 4). Setting this enables email+password login.
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Sessions — opaque session tokens for server-mode email+password login.
 * The token itself never lives in the DB; we store its SHA-256 hash and a
 * TTL. Cookies hold the plaintext token, HttpOnly + Secure at the Fastify
 * layer.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Passkeys — WebAuthn credentials. Each user can register multiple
 * (phone, laptop, hardware key) and authenticate with any of them.
 *
 * `credentialId` is the public credential identifier (base64url-encoded);
 * `publicKey` is the credential's CBOR-encoded public key as a base64url
 * string. Counter is the signature counter (for cloned-key detection).
 */
export const passkeys = pgTable('passkeys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  // 'platform' (built-in: Face ID / Windows Hello) | 'cross-platform' (USB key)
  deviceType: text('device_type'),
  // Friendly name for the UI: "iPhone 17", "YubiKey 5C", etc.
  label: text('label').notNull().default('passkey'),
  // Transports advertised by the authenticator at registration time.
  transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
  backedUp: boolean('backed_up').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
});

/**
 * WebAuthn ceremony state — temporary store for the challenge issued during
 * registration / authentication. Trades a row per attempt for stateless
 * verification on the second call. Cleaned up on success/use, expires after
 * a few minutes for orphan attempts.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: uuid('id').defaultRandom().primaryKey(),
  // For registration the user is known (we issued the challenge while they
  // were logged in). For authentication userId is NULL until verify.
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  challenge: text('challenge').notNull().unique(),
  // 'registration' | 'authentication'
  kind: text('kind').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // Stable URL-friendly handle; used in routes and as part of MCP token scope.
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const orgMemberships = pgTable(
  'org_memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'super_admin' | 'admin' | 'member'
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index('org_memberships_user_idx').on(t.userId),
  ],
);

export const spaces = pgTable('spaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Kept for backwards-compat with single-user bootstrap; in multi-tenant it's
  // just "the user that created the workspace".
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Per-workspace ACL: roles within a single space.
export const memberships = pgTable(
  'memberships',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'admin' | 'editor' | 'viewer'
    role: text('role').notNull().default('editor'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index('memberships_user_idx').on(t.userId),
  ],
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
  // Yjs CRDT state (binary). While clients are connected via Hocuspocus the
  // in-memory Y.Doc is authoritative; this column is the persisted snapshot
  // for hydration on next open. Null = no Yjs state yet (legacy notes seed
  // a fresh Y.Doc from contentMd on first edit). See migration 0007.
  yjsState: bytea('yjs_state'),
  yjsUpdatedAt: timestamp('yjs_updated_at'),
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
    // pgvector column without a fixed dimension. Migration 0008 relaxed the
    // original `vector(1536)` so that Ollama (1024) and Azure (1536) can
    // co-exist (and so users who arrived with Ollama from day one don't get
    // a 500 on the very first INSERT). Reads use the `number[]` type that
    // drizzle's `vector` produces; under the hood pgvector accepts any
    // dimensionality and only compares vectors of matching dim at query time.
    embedding: vectorAnyDim('embedding'),
  },
  (t) => [
    index('chunks_space_idx').on(t.spaceId),
    // Keyword search (BM25/FTS) in Spanish content.
    index('chunks_fts_idx').using('gin', sql`to_tsvector('spanish', ${t.text})`),
    // Vector search (cosine). Without a fixed dim we can't use HNSW/IVFFlat
    // (both require dim-aware ops). Sequential scan over <100k chunks
    // performs fine for alpha; when the user picks a definitive embedder
    // they can re-pin the dim + recreate the index via migration.
  ],
);

// Per-user access tokens (used by Claude/Copilot to connect via MCP).
// Only the HASH is stored, never the cleartext token.
export const tokens = pgTable('tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  // userId NULL when the token belongs to an org (org-wide service token).
  // For user tokens userId is set and orgId is NULL.
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  name: text('name').notNull().default('token'),
  // Granular scopes: `read`, `write`, `admin`, `space:<id>`, `org:<id>`.
  // Empty array = legacy user token (acts as the owner's full identity, which
  // is the behaviour pre-v4.x; kept for backwards-compat with existing tokens).
  scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
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
