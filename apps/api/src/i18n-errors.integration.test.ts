import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Errors come back in the reader's language, with a stable code.
 *
 * The web renders `body.error` straight to the user — the login screen, the
 * password reset, the forgot-password flow all do — so this is what a Spanish
 * speaker actually reads when something fails.
 *
 * The `code` matters more for clients: string-matching a message breaks when
 * the wording improves, and breaks once per language.
 */

describe('API errors honour Accept-Language', () => {
  let app: FastifyInstance;
  let sql: Sql;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const missing = async (lang?: string) => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/notes/00000000-0000-4000-8000-000000000000',
      headers: lang ? { 'accept-language': lang } : {},
    });
    expect(r.statusCode).toBe(404);
    return r.json() as { error: string; code: string };
  };

  it('answers in English by default', async () => {
    expect((await missing()).error).toBe('not found');
  });

  it('answers in Spanish when asked', async () => {
    expect((await missing('es')).error).toBe('no encontrado');
  });

  it('falls back through the base language, so es-AR gets Spanish', async () => {
    expect((await missing('es-AR,es;q=0.9')).error).toBe('no encontrado');
    expect((await missing('pt-BR')).error).toBe('não encontrado');
  });

  it('gives English for a language it does not have', async () => {
    // A half-translated error is worse than a consistent one.
    expect((await missing('de-DE,de;q=0.9')).error).toBe('not found');
  });

  /**
   * The part clients should actually depend on. A message is for humans and
   * will keep improving; the code is the contract.
   */
  it('carries a stable code that does not change with the language', async () => {
    const en = await missing('en');
    const es = await missing('es');
    const zh = await missing('zh');
    expect(en.code).toBe('note.notFound');
    expect(es.code).toBe('note.notFound');
    expect(zh.code).toBe('note.notFound');
    expect(new Set([en.error, es.error, zh.error]).size).toBe(3);
  });

  it('localises an interpolated message and keeps the value verbatim', async () => {
    const spaces = await app.inject({ method: 'GET', url: '/api/spaces' });
    const spaceId = (spaces.json() as { id: string }[])[0].id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/members`,
      headers: { 'accept-language': 'es' },
      payload: { email: 'x@y.z', role: 'inventado' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error: string; code: string };
    expect(body.code).toBe('role.invalid');
    expect(body.error).toBe('rol inválido: inventado');
  });

  // English is byte-identical to what these endpoints returned before the
  // catalog existed, which is what made the migration additive for every
  // client and every existing test.
  it('did not change the English wording of a migrated error', async () => {
    expect((await missing('en')).error).toBe('not found');
  });
});
