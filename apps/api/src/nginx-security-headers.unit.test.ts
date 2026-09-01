import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The two nginx configs must carry the security headers, in the same places.
 *
 * `docker/nginx.conf` (the `web` image) and `docker/nginx.allinone.conf` are
 * near-duplicates that have to say the same thing about a policy — the shape
 * that drifts. The e2e suite checks the headers for real, but only against
 * the all-in-one image; nothing in CI ever starts the web-only one, so this
 * reads both files as data.
 *
 * It also guards the two decisions that are easy to undo by accident: that
 * scripts stay strict, and that the proxied locations do NOT add a second
 * Content-Security-Policy on top of Helmet's.
 */

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, 'docker', p), 'utf8');

const SNIPPET = 'include /etc/nginx/security-headers.conf;';

/** The body of one `location <match> { … }` block, brace-matched. */
function locationBody(conf: string, match: string): string {
  const at = conf.indexOf(`location ${match}`);
  expect(at, `location ${match} not found`).toBeGreaterThan(-1);
  const open = conf.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    else if (conf[i] === '}' && --depth === 0) return conf.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after location ${match}`);
}

describe('nginx security headers', () => {
  const headers = read('nginx-security-headers.conf');

  it('sends a Content-Security-Policy that keeps scripts strict', () => {
    const csp = /add_header Content-Security-Policy "([^"]+)"/.exec(headers)?.[1];
    expect(csp, 'no CSP in the shared snippet').toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Styles are the documented exception (Vite critical CSS, CodeMirror).
    // Scripts are not, and that is the half that matters for XSS.
    const scriptSrc = /script-src ([^;]+)/.exec(csp ?? '')?.[1] ?? '';
    expect(scriptSrc).not.toMatch(/unsafe-inline/);
    expect(scriptSrc).not.toMatch(/unsafe-eval/);
  });

  it('marks every header `always`, so error responses carry them too', () => {
    for (const line of headers.split('\n').filter((l) => l.trim().startsWith('add_header'))) {
      expect(line.trimEnd(), line).toMatch(/always;$/);
    }
  });

  for (const conf of ['nginx.conf', 'nginx.allinone.conf']) {
    describe(conf, () => {
      const text = read(conf);

      it('includes the headers in every location that serves the app', () => {
        // The SPA fallback delivers the document; the other two set their own
        // `add_header`, which in nginx DROPS everything inherited from the
        // server block — so each has to include the snippet itself.
        expect(locationBody(text, '/ {')).toContain(SNIPPET);
        expect(locationBody(text, '= /index.html')).toContain(SNIPPET);
        expect(locationBody(text, '~*')).toContain(SNIPPET);
      });

      it('leaves the proxied locations to Helmet', () => {
        // Two Content-Security-Policy headers are not additive: the browser
        // enforces both, so the effective policy is their intersection and a
        // change here would tighten the API's by accident.
        expect(locationBody(text, '/api/')).not.toContain(SNIPPET);
        expect(locationBody(text, '/mcp')).not.toContain(SNIPPET);
      });
    });
  }
});
