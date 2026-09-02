import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  doublePrecision,
  real,
  boolean,
  vector,
  primaryKey,
  index,
  uniqueIndex,
  customType,
  bigserial,
  bigint,
  jsonb,
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

/**
 * `regconfig` — the Postgres text-search configuration a row is indexed with.
 *
 * A real `regconfig`, not text: the cast from text is STABLE (it depends on
 * `search_path`), and the generated `tsv` column below needs an immutable
 * expression. As a regconfig it is immutable, and a typo fails on write.
 */
const regconfig = customType<{ data: string }>({ dataType: () => 'regconfig' });

/** `tsvector` — the lexemes of a chunk, computed once at write time. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// Data model — three tiers of ownership / permissions (PRD §12 + v4.1 admin):
//
//   organization        — the company (e.g. "Acme Inc."). One per customer.
//                         Holds billing, branding, and the user roster.
//     org_memberships   — which users belong to the org and at what level:
//                           · org_admin: god mode (delete org, rename,
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
// Core runs a single bootstrapped "Local" org with one user (org_admin) and
// the historical default space. Cloud reuses the same model with Entra ID.

export const users = pgTable('users', {
  // ADR-005: who owns the INSTALLATION, as opposed to an organisation.
  // Not in `org_memberships` because it is not about an organisation — and
  // deliberately NOT a god over tenant data: administering the installation
  // does not entitle anyone to read what is stored in it. Reading an
  // organisation's notes still needs membership in that organisation.
  setupAdmin: boolean('setup_admin').notNull().default(false),
  id: uuid('id').defaultRandom().primaryKey(),
  // Identity = email everywhere. Unique, lower-cased on write at the API.
  email: text('email').notNull().unique(),
  // Where this user came from. Drives downstream behaviour: an `oidc` user
  // cannot log in with password, a `csv_import` user has no password until
  // they finish a flow, etc. Existing values: 'local' | 'passkey' | 'oidc'
  // | 'trusted_header' | 'csv_import' | 'google' | 'microsoft'.
  provider: text('provider'),
  // Server-mode auth: PBKDF2 hash + salt as `pbkdf2$<iter>$<saltHex>$<hashHex>`.
  // Null for local-mode users (passwordless) and for users that only auth via
  // passkey, OIDC, or trusted_header.
  passwordHash: text('password_hash'),
  // Optional display name parts. Populated by:
  //   - CSV import (admin uploads names + emails up-front).
  //   - OIDC JIT (token claims like `given_name`/`family_name`).
  //   - User editing their own profile.
  firstName: text('first_name'),
  lastName: text('last_name'),
  // Soft-disable. False = the IdP / SSO / login flow still works against the
  // upstream, but Diluxite responds 403 "your admin disabled your account".
  // Preferred over hard-delete because it preserves historical authorship
  // (notes, audit log, etc.).
  active: boolean('active').notNull().default(true),
  // Last successful authentication. Updated by the AuthProvider on resolve.
  // Cheap clock for "is this user inactive for 90+ days, deprovision"
  // reports later on.
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Per-org settings that need a real table (not env vars) because the org admin
 * changes them at runtime through the Admin UI. Today only `authPolicy` lives
 * here; future settings (default workspace template, branding) will join it.
 *
 * `authPolicy` answers the question "what happens when somebody finishes
 * SSO/SAML/header auth successfully BUT doesn't exist in our users table?":
 *
 *  - `deny_unknown`: refuse with 403. Strictest. Use when you pre-provision
 *    every user via CSV import and the IdP is locked down to that set.
 *  - `allow_unknown_as_member`: JIT-create with role 'member' (lowest perm).
 *    Lets people log in but they see nothing until the admin assigns space
 *    memberships. Reasonable default.
 *  - `pre_provisioned_only`: same as deny_unknown but the message is friendlier
 *    ("Talk to your admin to provision your account"). For UX when the admin
 *    HAS imported a CSV and just missed somebody.
 *
 * NOTE: `local` mode org never reads this — single-user, no policy decision.
 */
export const orgSettings = pgTable('org_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  authPolicy: text('auth_policy').notNull().default('allow_unknown_as_member'),
  /**
   * Search configuration for the org (migration 0026). These lived in each
   * browser's localStorage while the control for them sat in the admin
   * console — a setting that lied about its own scope.
   */
  searchMode: text('search_mode').notNull().default('hybrid'),
  searchTopK: integer('search_top_k').notNull().default(5),
  // What standing is worth in the order (migration 0037). Multipliers, so a
  // strong match slightly overdue still beats a weak match that is fresh.
  rankWeightPreferred: real('rank_weight_preferred').notNull().default(1.2),
  rankWeightStale: real('rank_weight_stale').notNull().default(0.9),
  rankWeightExpired: real('rank_weight_expired').notNull().default(0.4),
  rankHideExpired: boolean('rank_hide_expired').notNull().default(false),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
  // timestamptz since 0021 — compared against NOW() for session expiry.
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Filled in by the API at login + refreshed on every authenticated request.
  // Nullable for sessions created before migration 0014.
  ip: text('ip'),
  userAgent: text('user_agent'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
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
    // 'org_admin' | 'org_member'
    // ADR-005: org_admin | org_member. The CHECK lives in migration 0030 —
    // a role outside the set should fail on write, not surprise a policy on
    // read, which is exactly how the rename broke `diluxite_is_org_admin`.
    role: text('role').notNull().default('org_member'),
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
    // Cascade since 0018 — deleting a space takes its notes with it. The
    // original NO ACTION made DELETE /api/spaces/:spaceId 500 on FK violation.
    .references(() => spaces.id, { onDelete: 'cascade' }),
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
  // Soft delete (alpha.43 / migration 0016). Null = active; non-null = in trash.
  // Listings + search + MCP filter by `deleted_at IS NULL` so trashed notes
  // disappear from normal views. Endpoints under /api/spaces/:id/trash +
  // /api/notes/:id/restore expose the trash UX.
  deletedAt: timestamp('deleted_at'),
  // Archived (migration 0035). Null = live. An archived note leaves the tree
  // and the recents but KEEPS answering search and MCP, marked and ranked
  // below live ones — see the migration for why it is a flag and not a move.
  archivedAt: timestamp('archived_at'),
}, (t) => [
  // Partial UNIQUE (migration 0020): at most one LIVE note per (space, title).
  // Backs the atomic get-or-create in `createIfAbsent` (TOCTOU fix). Trashed
  // rows are exempt so a title can be reused after its note is trashed.
  uniqueIndex('notes_space_title_live_uniq')
    .on(t.spaceId, t.title)
    .where(sql`${t.deletedAt} IS NULL`),
]);

/**
 * How often an entity is used to answer (migration 0038).
 *
 * Counters only, never a log of individual uses: a log grows with traffic and
 * records who read what, which is surveillance nobody asked for. The queue
 * needs "how much does this get leaned on", and that is a number.
 */
export const entityUsage = pgTable(
  'entity_usage',
  {
    entityKind: text('entity_kind').notNull(),
    entityId: uuid('entity_id').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    useCount: bigint('use_count', { mode: 'number' }).notNull().default(0),
    firstUsedAt: timestamp('first_used_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.entityKind, t.entityId] })],
);

// Immutable snapshots of a note's content as it was BEFORE each save
// (migration 0023). Written by NotesService.update when contentMd genuinely
// changes; a coalescing window collapses save-bursts (collab flushes every
// ~2s) and a per-note cap bounds the cost. `space_id` is denormalised for the
// same reason as chunks: tenant filtering without a join, and the standard
// space-member RLS policy.
export const noteVersions = pgTable(
  'note_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    contentMd: text('content_md').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    // Listing is always "this note, newest first"; pruning walks the same order.
    index('note_versions_note_created_idx').on(t.noteId, t.createdAt.desc()),
    index('note_versions_space_idx').on(t.spaceId),
  ],
);

/**
 * Facts derived from the tables inside notes — ADR-001 step 2.
 *
 * Derived at save time like `note_tags` and `note_links`, never authored. A
 * note's whole set is replaced on re-derivation, so there is no update path
 * and no second copy that can drift from the markdown.
 */
export const facts = pgTable(
  'facts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    keyColumn: text('key_column').notNull(),
    key: text('key').notNull(),
    columnName: text('column_name').notNull(),
    value: text('value').notNull(),
    /** prov:wasDerivedFrom at line granularity. */
    sourceLine: integer('source_line').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('facts_note_idx').on(t.noteId), index('facts_space_idx').on(t.spaceId)],
);

/**
 * Provenance, validity and rank — ADR-002.
 *
 * Three orthogonal axes, each from an existing standard: W3C PROV-O (which
 * Agent, which Activity, derived from what), SQL:2011 bitemporal (the world's
 * timeline in `validFrom`/`validTo`, ours in `recordedAt`), and Wikidata ranks
 * (`preferred`/`normal`/`deprecated`, where superseded is kept rather than
 * deleted).
 *
 * Keyed by (entityKind, entityId) rather than by noteId: today a note is the
 * only entity, but a table row becomes one when query_facts lands, and it
 * reuses these rows unchanged. A `noteId` column would have deferred a
 * migration the ADR promised not to defer.
 */
export const entityProvenance = pgTable(
  'entity_provenance',
  {
    entityKind: text('entity_kind').notNull(),
    entityId: uuid('entity_id').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    // PROV Agent. Nullable on purpose: a collab flush is authored by whoever
    // was typing during the debounce, which can be several people. Recording a
    // plausible single author would be inventing provenance.
    attributedTo: uuid('attributed_to').references(() => users.id, { onDelete: 'set null' }),
    agentKind: text('agent_kind').notNull().default('user'),
    // PROV Activity: which door the write came through.
    generatedBy: text('generated_by').notNull().default('editor'),
    // prov:wasDerivedFrom.
    derivedFromNoteId: uuid('derived_from_note_id').references(() => notes.id, {
      onDelete: 'set null',
    }),
    derivedFromLine: integer('derived_from_line'),
    derivedFromRef: text('derived_from_ref'),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    // Null = open window. A date in the FUTURE is an expiry somebody declared;
    // a date in the past is what makes the entity expired, evaluated at query
    // time by comparison — never by a job that walks the corpus (ADR-002).
    validTo: timestamp('valid_to', { withTimezone: true }),
    // Who signed it, and when (migration 0036). Deliberately NOT `attributedTo`,
    // which is the author of the content: confirming must not rewrite
    // authorship.
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    rank: text('rank').notNull().default('normal'),
  },
  (t) => [
    primaryKey({ columns: [t.entityKind, t.entityId] }),
    index('entity_provenance_space_idx').on(t.spaceId),
  ],
);

/**
 * How often an entity actually changes — ADR-002's decay half.
 *
 * Separate from provenance because the write rates differ by orders of
 * magnitude: provenance is written once and amended rarely, these counters
 * move on every content save (a collab flush is ~every 2s while someone
 * types).
 *
 * `avgIntervalSeconds` is an EWMA of the gap between changes, maintained in
 * constant time on save — no scheduled job and no pass over the corpus. NULL
 * until there are two changes to measure between, at which point a reader
 * falls back to a structural prior rather than to a number invented here.
 */
export const entityChangeStats = pgTable(
  'entity_change_stats',
  {
    entityKind: text('entity_kind').notNull(),
    entityId: uuid('entity_id').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).defaultNow().notNull(),
    changeCount: integer('change_count').notNull().default(0),
    avgIntervalSeconds: doublePrecision('avg_interval_seconds'),
  },
  (t) => [
    primaryKey({ columns: [t.entityKind, t.entityId] }),
    index('entity_change_stats_space_idx').on(t.spaceId),
  ],
);

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
    /**
     * The text-search configuration THIS chunk is indexed with — migration
     * 0033. Written at index time from the language detected in the note
     * (`detectLanguage`, packages/core/src/language.ts); 'spanish' is what
     * every row written before that existed carries, and what a note whose
     * language cannot be told still gets.
     */
    ftsConfig: regconfig('fts_config').notNull().default('spanish'),
    /**
     * The lexemes, stored. This is what makes per-language indexing possible:
     * an expression index can only ever hold ONE configuration, so
     * `to_tsvector('spanish', text)` was not something the index could fix.
     * A stored column holds a different configuration per row.
     */
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector(fts_config, text)`),
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
    // Keyword search (FTS). On the stored `tsv`, so one index serves every
    // language: the configuration lives in the row, not in the index.
    index('chunks_tsv_idx').using('gin', t.tsv),
    // Vector search (cosine). Without a fixed dim we can't use HNSW/IVFFlat
    // (both require dim-aware ops). Sequential scan over <100k chunks
    // performs fine for alpha; when the user picks a definitive embedder
    // they can re-pin the dim + recreate the index via migration.
  ],
);

/**
 * Vectors, one partition per embedding model — ADR-003.
 *
 * Declared as a plain table because that is what it is to a caller: drizzle
 * inserts into the parent and Postgres routes the row to the right partition.
 * The partitions themselves, their pinned dimension and their HNSW index are
 * managed by `DrizzleEmbeddingModelsRepository`, since they come and go with
 * the models rather than with the schema.
 */
export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    /**
     * `"<org_id>:<provider:model@dims>"` — the partition an organisation's
     * vectors live in (ADR-005). Organisation first, so two organisations on
     * the same model never share one: a shared HNSW index returns the smaller
     * tenant nothing, because its nearest candidates all belong to the larger.
     */
    slot: text('slot').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    embedding: vectorAnyDim('embedding').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.slot] }),
    index('chunk_embeddings_space_idx').on(t.spaceId),
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
  /**
   * Optional expiration. NULL = no TTL (legacy behaviour, kept for
   * backwards-compat with tokens minted before migration 0009). When set,
   * `findUserIdByToken` returns null past this instant.
   *
   * timestamptz since 0021 — compared against NOW() in `notExpired`.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
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

/**
 * TOTP secrets — one row per user with 2FA enabled. The row only appears
 * AFTER `verify-enroll` confirms with a valid code; pending enrolls keep
 * the candidate secret in memory (in a short-lived token) and never reach
 * here, so orphaned secrets can't accumulate.
 *
 * `backup_codes` is an array of SHA-256 hashes of single-use recovery codes.
 * Each successful use of a backup code REWRITES the row without that hash.
 *
 * See `totp_secrets` migration (0013) for the design rationale on plaintext
 * `secret` storage.
 */
export const totpSecrets = pgTable('totp_secrets', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).defaultNow().notNull(),
  backupCodes: text('backup_codes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
});

/**
 * Audit events — append-only registry of security and admin actions.
 *
 * Migration 0012. `action` is a dotted convention string ("auth.login.success",
 * "admin.user.role_changed", etc.) so filters can match by prefix without a
 * closed enum. `metadata` holds event-specific detail (counts, target email,
 * scope, etc.). `actor_id` is nullable because failed logins don't have a
 * verified identity — we put the attempted email into metadata instead.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resource: text('resource'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('audit_events_at_idx').on(t.at.desc()),
    index('audit_events_org_at_idx').on(t.orgId, t.at.desc()),
    index('audit_events_actor_idx').on(t.actorId),
    // text_pattern_ops (migration 0022) so the `action LIKE 'prefix%'` filter
    // is index-usable regardless of the DB collation.
    index('audit_events_action_idx').on(t.action.op('text_pattern_ops')),
  ],
);

/**
 * Forgot-password reset tokens (migration 0015).
 *
 * `token_hash` is SHA-256 of the random token sent by email — the plain
 * token only exists in transit. `consumed_at` is set when the reset succeeds
 * so the token can't be reused. Rows are kept for audit.
 *
 * RLS (migration 0019): the reset flow looks this row up by `token_hash`
 * BEFORE any user identity exists in the session, so it CANNOT be scoped to
 * `diluxite_current_user_id()` without breaking reset. RLS is enabled +
 * forced with NO permissive policy (deny-by-default for tenant roles); the
 * row is reachable only via the service role that holds BYPASSRLS. No
 * tenant-facing endpoint reads it today.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    // timestamptz since 0021 — compared against NOW() for expiry.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at'),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('password_resets_user_idx').on(t.userId),
    index('password_resets_expires_idx').on(t.expiresAt),
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
