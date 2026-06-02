import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from './app';
import { SingleUserAuthProvider } from '@diluxite/core';

/**
 * Tests furiosos de los security headers (@fastify/helmet).
 *
 * Política: el integration setup global desactiva helmet para no inflar
 * la suite con headers. Estos tests lo REACTIVAN y verifican que cada
 * header esté presente y bien formado. Si alguien rompe la config de
 * Helmet (e.g. saca CSP por accidente, deshabilita HSTS), este suite
 * falla.
 *
 * Cobertura:
 *   - CSP: present, contiene 'default-src 'self'', NO contiene 'unsafe-inline' en script-src.
 *   - HSTS: max-age >= 1 año, includeSubDomains presente.
 *   - X-Content-Type-Options: nosniff.
 *   - Referrer-Policy: strict-origin-when-cross-origin.
 *   - X-Frame-Options o frame-ancestors: rechaza embedding.
 *   - El opt-out (DILUXITE_HELMET_DISABLED=1) realmente quita los headers.
 */

function stubDeps(): AppDeps {
  return {
    notes: {} as never,
    search: {} as never,
    spaces: {} as never,
    organizations: {} as never,
    users: {} as never,
    tokens: {} as never,
    tags: {} as never,
    links: {} as never,
    folders: {} as never,
    auth: new SingleUserAuthProvider('test-user'),
    info: { embedder: 'local', version: '0.0.0', authMode: 'local' },
  };
}

describe('Security headers (helmet enabled)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.DILUXITE_HELMET_DISABLED = '0';
    delete process.env.DILUXITE_RATE_LIMIT_DISABLED;
    app = await buildApp(stubDeps());
    await app.ready();
  });

  afterEach(async () => {
    process.env.DILUXITE_HELMET_DISABLED = '1';
    process.env.DILUXITE_RATE_LIMIT_DISABLED = '1';
    await app.close();
  });

  it('CSP: present + default-src self + script-src strict (no unsafe-inline)', async () => {
    const r = await app.inject({ url: '/health' });
    const csp = r.headers['content-security-policy'] as string | undefined;
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    // Script src must NOT include unsafe-inline (XSS vector).
    // If helmet uses a default 'script-src' from defaultSrc fallback, that
    // also doesn't include unsafe-inline — both shapes are OK.
    if (csp!.includes('script-src')) {
      const scriptSrc = csp!.match(/script-src ([^;]+)/i)?.[1] ?? '';
      expect(scriptSrc).not.toMatch(/'unsafe-inline'/i);
    }
    // frame-ancestors none — protects against being iframed by malicious sites.
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it('HSTS: max-age >= 1 year + includeSubDomains', async () => {
    const r = await app.inject({ url: '/health' });
    const hsts = r.headers['strict-transport-security'] as string | undefined;
    expect(hsts).toBeTruthy();
    const maxAge = Number(hsts!.match(/max-age=(\d+)/i)?.[1] ?? '0');
    expect(maxAge).toBeGreaterThanOrEqual(60 * 60 * 24 * 365);
    expect(hsts).toMatch(/includeSubDomains/i);
  });

  it('X-Content-Type-Options: nosniff', async () => {
    const r = await app.inject({ url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const r = await app.inject({ url: '/health' });
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('Cross-Origin-Opener-Policy: same-origin', async () => {
    const r = await app.inject({ url: '/health' });
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('Cross-Origin-Resource-Policy: same-origin', async () => {
    const r = await app.inject({ url: '/health' });
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('Security headers — opt-out flag', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    process.env.DILUXITE_HELMET_DISABLED = '1';
    if (app) await app.close();
  });

  it('DILUXITE_HELMET_DISABLED=1 → no headers added (used by integration suite)', async () => {
    process.env.DILUXITE_HELMET_DISABLED = '1';
    app = await buildApp(stubDeps());
    await app.ready();
    const r = await app.inject({ url: '/health' });
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });
});
