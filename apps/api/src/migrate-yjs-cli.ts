/**
 * One-off migration: seed `yjs_state` for all notes that don't have one yet.
 *
 * Why this exists
 * ───────────────
 * Notes created before collab landed only have `content_md`. The first time
 * someone opens one of these in the collab editor, `onLoadDocument` lazily
 * seeds the Y.Doc from `content_md` (see collab.ts). That works, but means
 * every legacy note pays the seed cost on first open and the search ranking
 * can read a doc with no CRDT context yet.
 *
 * This CLI walks the whole `notes` table once, seeds every note that has
 * `yjs_state IS NULL`, and writes the binary state + bumps `yjs_updated_at`.
 * After it runs, every note is collab-ready from the next open.
 *
 * Usage
 * ─────
 *   DATABASE_URL=postgres://... pnpm exec tsx src/migrate-yjs-cli.ts
 *
 * Idempotent — re-running it skips notes that already have a state. Safe to
 * call from a Watchtower post-update hook, a cron, or manually after a
 * deploy.
 */

import * as Y from 'yjs';
import postgres from 'postgres';
import { Y_TEXT_KEY } from './collab';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  let migrated = 0;

  try {
    const rows = await sql<{ id: string; content_md: string }[]>`
      SELECT id, content_md FROM notes WHERE yjs_state IS NULL
    `;
    console.log(`Found ${rows.length} notes without yjs_state`);

    for (const row of rows) {
      const doc = new Y.Doc();
      doc.getText(Y_TEXT_KEY).insert(0, row.content_md ?? '');
      const state = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();

      await sql`
        UPDATE notes
        SET yjs_state = ${state}, yjs_updated_at = NOW()
        WHERE id = ${row.id}::uuid AND yjs_state IS NULL
      `;
      migrated++;
      if (migrated % 50 === 0) console.log(`  …${migrated} migrated`);
    }

    const remaining = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM notes WHERE yjs_state IS NULL
    `;
    const skipped = Number(remaining[0]?.count ?? 0);

    console.log(`✅ Done. Migrated: ${migrated}. Still null: ${skipped}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('❌ migrate-yjs-cli failed:', err);
  process.exit(1);
});
