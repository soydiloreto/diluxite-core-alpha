import { test, expect, request } from '@playwright/test';

/**
 * The page that runs the app is served with a policy.
 *
 * A browser enforces a page's CSP from the response that delivered the
 * DOCUMENT. Helmet's careful policy sits on `/api/*` — JSON that nobody
 * executes — while `index.html` came from nginx with no headers at all, so
 * anything that got a `<script>` into the page ran unopposed. The unit test in
 * `apps/api` reads the two nginx configs as data; this one asks the running
 * image what it actually sends, which is the only version of the question that
 * cannot be satisfied by a config that never loaded.
 *
 * Needs the same running stack as the other suites — in CI, the all-in-one
 * container image.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test.describe('security headers on the document', () => {
  test('index.html carries a CSP that keeps scripts strict', async () => {
    const api = await request.newContext();
    try {
      const res = await api.get(`${BASE_URL}/`);
      expect(res.status()).toBe(200);

      const csp = res.headers()['content-security-policy'];
      expect(csp, 'the document was served without a Content-Security-Policy').toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");

      const scriptSrc = /script-src ([^;]+)/.exec(csp ?? '')?.[1] ?? '';
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);

      expect(res.headers()['x-content-type-options']).toBe('nosniff');
      expect(res.headers()['x-frame-options']).toBe('DENY');
      expect(res.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    } finally {
      await api.dispose();
    }
  });

  test('the app still loads under it — no blocked script, no blank page', async ({ page }) => {
    // A CSP that breaks the bundle would pass every header assertion above.
    // The violation surfaces as a console error, so watch for it and then
    // check that the app actually rendered.
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) {
        violations.push(m.text());
      }
    });
    await page.goto(BASE_URL);
    await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('a hashed asset is not served bare', async () => {
    // The asset location sets its own Cache-Control, and in nginx that DROPS
    // every header inherited from the server block. This is the regression
    // that shape invites.
    const api = await request.newContext();
    try {
      const html = await (await api.get(`${BASE_URL}/`)).text();
      const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(asset, 'no hashed script in index.html').toBeTruthy();
      const res = await api.get(`${BASE_URL}${asset}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-security-policy']).toBeTruthy();
      expect(res.headers()['cache-control']).toContain('immutable');
    } finally {
      await api.dispose();
    }
  });
});
