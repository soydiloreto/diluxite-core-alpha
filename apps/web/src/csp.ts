/**
 * The per-request CSP nonce, when the page was served with one.
 *
 * nginx stamps it into `index.html` and into the `Content-Security-Policy`
 * header on the same response, so anything that injects a `<style>` at runtime
 * can be allowed by name. Without it the policy would need `'unsafe-inline'`
 * for styles — which also allows every inline style an XSS could write.
 *
 * `undefined` in three cases, all of them meaning "there is no nonce to use":
 * `pnpm dev` (no nginx, the placeholder is still there), a deployment serving
 * the bundle from something else, and any test environment.
 */
const PLACEHOLDER = '__CSP_NONCE__';

let cached: string | null | undefined;

export function cspNonce(): string | undefined {
  if (cached === undefined) {
    const meta = document.querySelector('meta[property="csp-nonce"]');
    const value = meta?.getAttribute('content') ?? '';
    cached = value && value !== PLACEHOLDER ? value : null;
  }
  return cached ?? undefined;
}
