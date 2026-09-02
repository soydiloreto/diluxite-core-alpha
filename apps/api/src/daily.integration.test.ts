import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Today's page: created by a routine rather than by a thought, which is why
 * the title, the folder and the template have to agree everywhere.
 */
describe('daily notes (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  const open = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/daily`, payload });

  const today = () => new Date().toISOString().slice(0, 10);

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it("creates today's page, titled with the date and filed by month", async () => {
    const r = await open();
    expect(r.statusCode).toBe(200);
    expect(r.json().created).toBe(true);
    expect(r.json().note.title).toBe(today());

    const [folder] = await sql<{ name: string }[]>`
      SELECT f.name FROM folders f JOIN notes n ON n.folder_id = f.id
       WHERE n.title = ${today()}`;
    expect(folder.name).toBe(today().slice(0, 7));
  });

  it('opening it again returns the same page, never a second one', async () => {
    const first = (await open()).json();
    const second = (await open()).json();
    expect(second.created).toBe(false);
    expect(second.note.id).toBe(first.note.id);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM notes WHERE title = ${today()}`;
    expect(count).toBe(1);
  });

  it('seeds from the template note, filling the date and the back-link', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: {
        title: 'Template: Daily',
        contentMd: '# {{date}}\n\nAyer: [[{{yesterday}}]]\n\n## Qué aprendí',
      },
    });

    const note = (await open()).json().note;
    expect(note.contentMd).toContain(`# ${today()}`);
    expect(note.contentMd).toContain('## Qué aprendí');
    // The back-link is what turns a pile of dailies into a chain.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(note.contentMd).toContain(`[[${yesterday}]]`);
  });

  it('a space with no template still gets its page', async () => {
    // A missing template is the normal state, not an error.
    expect((await open()).json().created).toBe(true);
  });

  it('an explicit date opens that day instead of today', async () => {
    const r = await open({ date: '2026-03-15' });
    expect(r.json().note.title).toBe('2026-03-15');
    const [folder] = await sql<{ name: string }[]>`
      SELECT f.name FROM folders f JOIN notes n ON n.folder_id = f.id
       WHERE n.title = '2026-03-15'`;
    expect(folder.name).toBe('2026-03');
  });

  it('refuses a date that is not one', async () => {
    expect((await open({ date: 'el viernes' })).statusCode).toBe(400);
  });

  it('the timezone offset decides which day it is', async () => {
    // Sent the way a browser has it (`getTimezoneOffset`): UTC-3 is +180.
    // Without this, somebody in Buenos Aires gets tomorrow's page at 9pm.
    const r = await open({ tzOffsetMinutes: 1440 });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(r.json().note.title).toBe(yesterday);
  });
});
