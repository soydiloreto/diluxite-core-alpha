/**
 * Resolvers for live state — ADR-001 step 3.
 *
 * The bridge half of the retrieval architecture. Metrics, ticket status and
 * dashboards are **not copied into the memory**: a note declares WHERE to ask,
 * and the engine resolves at query time with a cache.
 *
 * Copying is what makes a second brain wrong in the way that matters — the
 * number was right when it was pasted, and nothing about the page says it
 * stopped being right. A resolver has the opposite failure mode: it can be
 * unreachable, and being unreachable is something the answer can say.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: no value is ever returned without the
 * date it was true. "MRR 42k (12 minutes ago)" is something you say out loud;
 * "MRR 42k (March)" is something you go check. Same number, opposite
 * behaviour, and the difference is a timestamp.
 */

/** A live value a note asks for, declared in the note itself. */
export interface ResolverSpec {
  /** What to call it in an answer. Unique within the note. */
  name: string;
  /** Where to ask. Only what the operator allowlisted is ever called. */
  url: string;
  /**
   * Which field of the JSON response holds the value — a dotted path, or
   * absent when the response IS the value.
   */
  path?: string;
  /** How long an answer stays fresh, in seconds. */
  ttlSeconds: number;
  /** 1-indexed line where it was declared, for provenance. */
  line: number;
}

/** Why a declaration was ignored. Surfaced so a typo is visible, not silent. */
export type ResolverSkipReason =
  | 'no-name'
  | 'no-url'
  | 'url-not-http'
  | 'ttl-not-a-number'
  | 'duplicate-name';

export interface ResolverParse {
  resolvers: ResolverSpec[];
  skipped: { line: number; reason: ResolverSkipReason }[];
}

/** Below this a resolver would hammer its source; above it, nothing is live. */
export const MIN_TTL_SECONDS = 10;
export const MAX_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_TTL_SECONDS = 300;

/** Matched against an already-trimmed line, so there is nothing to backtrack. */
function isResolverFence(trimmed: string): boolean {
  if (!trimmed.startsWith('```')) return false;
  return trimmed.slice(3).trim().toLowerCase() === 'resolver';
}

/**
 * Read the resolvers a note declares.
 *
 * Derived from the markdown at save time, the same way tags, wikilinks and
 * facts are: nobody authors a resolver twice, so there is exactly one place to
 * correct a wrong one — the note.
 *
 * The block is deliberately boring — `key: value` lines inside a fenced
 * ```resolver block — because it has to be writable by a person in a note and
 * greppable afterwards. No new syntax, no new dependency.
 *
 *     ```resolver
 *     name: mrr
 *     url: https://metrics.example/api/mrr
 *     path: data.value
 *     ttl: 300
 *     ```
 */
export function parseResolvers(markdown: string): ResolverParse {
  const lines = markdown.split(/\r?\n/);
  const resolvers: ResolverSpec[] = [];
  const skipped: ResolverParse['skipped'] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    if (!isResolverFence(lines[i].trim())) continue;
    const start = i + 1;
    const fields = new Map<string, string>();
    let j = start;
    for (; j < lines.length && !lines[j].trimStart().startsWith('```'); j++) {
      // Split on the first colon rather than matching the whole line with a
      // regex: `^\s*([a-z_]+)\s*:` backtracks polynomially on a line of many
      // spaces, and these lines come out of a note, which is user input.
      const raw = lines[j];
      const colon = raw.indexOf(':');
      if (colon <= 0) continue;
      const key = raw.slice(0, colon).trim().toLowerCase();
      // Anchored, one character class, over an already-trimmed key: linear.
      if (!/^[a-z_]+$/.test(key)) continue;
      fields.set(key, raw.slice(colon + 1).trim());
    }
    i = j; // continue after the closing fence

    const declaredAt = start; // 1-indexed line of the first field
    const name = fields.get('name');
    const url = fields.get('url');
    if (!name) {
      skipped.push({ line: declaredAt, reason: 'no-name' });
      continue;
    }
    if (!url) {
      skipped.push({ line: declaredAt, reason: 'no-url' });
      continue;
    }
    // Parsed rather than pattern-matched: `javascript:` and `file:` are URLs
    // too, and a note is user input that reaches an HTTP client.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      skipped.push({ line: declaredAt, reason: 'url-not-http' });
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      skipped.push({ line: declaredAt, reason: 'url-not-http' });
      continue;
    }
    if (seen.has(name)) {
      // Two resolvers with one name would make the answer ambiguous, and the
      // note is the one place to fix it.
      skipped.push({ line: declaredAt, reason: 'duplicate-name' });
      continue;
    }

    const rawTtl = fields.get('ttl');
    let ttlSeconds = DEFAULT_TTL_SECONDS;
    if (rawTtl !== undefined) {
      const n = Number(rawTtl);
      if (!Number.isFinite(n)) {
        skipped.push({ line: declaredAt, reason: 'ttl-not-a-number' });
        continue;
      }
      ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(n)));
    }

    seen.add(name);
    resolvers.push({
      name,
      url: parsed.toString(),
      path: fields.get('path') || undefined,
      ttlSeconds,
      line: declaredAt,
    });
  }

  return { resolvers, skipped };
}

/**
 * Pull the value out of a JSON response.
 *
 * A dotted path, and nothing more: no expression language, no filters, no
 * wildcards. A query language here would be a second thing to learn and a
 * place for a note to make the server do work on its behalf.
 */
export function valueAtPath(body: unknown, path: string | undefined): unknown {
  if (!path) return body;
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** How a value is rendered in an answer. Objects are refused, not stringified. */
export function formatResolvedValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // An object or an array would print as `[object Object]` or as a wall of
  // JSON in the middle of a sentence. A resolver returning one is a resolver
  // pointed at the wrong field, and saying so beats printing noise.
  return null;
}

/**
 * How old a value is, in the words an answer uses.
 *
 * Not a date, on purpose: the whole reason this rule exists is that "12
 * minutes ago" and "March" trigger different behaviour in a person, and a
 * timestamp makes the reader do that arithmetic themselves.
 */
export function ageInWords(fetchedAt: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - fetchedAt.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

/** What one attempt at a live value produced. */
export type ResolveOutcome =
  | { ok: true; value: string }
  | { ok: false; error: string };

export interface ResolveOptions {
  /** The operator's credential for this host, when they configured one. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cap on the response body. A resolver reads one value, not a dataset. */
  maxBytes?: number;
}

export const RESOLVE_TIMEOUT_MS = 5_000;
export const RESOLVE_MAX_BYTES = 64 * 1024;

/**
 * Ask the source for one value.
 *
 * THE TRUST BOUNDARY IS THE ALLOWLIST, and it is checked by the caller before
 * this runs. A note is user input, and this function makes an outbound request
 * with a URL taken from it; without an operator saying which hosts may be
 * called, that is a server-side request forgery with a nice syntax.
 *
 * Three more limits, each for a failure this would otherwise have:
 *   - `redirect: 'error'` — following one leaves the allowlisted host, which
 *     is the whole check, undone in one hop.
 *   - a timeout — a source that hangs must not hold a search behind it.
 *   - a size cap — a resolver reads one value; anything large is a mistake
 *     somewhere, and streaming it into memory does not improve the mistake.
 *
 * Never throws: a failure is a value the caller shows ("could not reach it,
 * here is the last one, from an hour ago"), not an exception that swallows a
 * search.
 */
export async function resolveValue(
  spec: ResolverSpec,
  opts: ResolveOptions = {},
): Promise<ResolveOutcome> {
  const f = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? RESOLVE_TIMEOUT_MS);
  try {
    const res = await f(spec.url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
    });
    if (!res.ok) return { ok: false, error: `source answered ${res.status}` };

    const text = await res.text();
    if (text.length > (opts.maxBytes ?? RESOLVE_MAX_BYTES)) {
      return { ok: false, error: 'response too large' };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A plain-text endpoint is a legitimate source: a number in a body is
      // still a value. Only a body that is neither is a failure.
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 200) return { ok: false, error: 'response is not JSON' };
      return { ok: true, value: trimmed };
    }
    const formatted = formatResolvedValue(valueAtPath(body, spec.path));
    if (formatted === null) {
      return {
        ok: false,
        error: spec.path ? `no scalar value at "${spec.path}"` : 'response is not a value',
      };
    }
    return { ok: true, value: formatted };
  } catch (e) {
    // Includes the abort. The message is shown to a person, so it says what
    // happened rather than what class was thrown.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? 'source timed out' : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Is this URL's host one the operator allowed? Exact host, never a suffix. */
export function hostAllowed(url: string, allowed: Iterable<string>): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  // Exact match on host (name plus port), deliberately: matching a suffix
  // would let `metrics.example.attacker.com` pass an allowlist that says
  // `example.com`, which is the classic way this check is got wrong.
  for (const a of allowed) if (a.trim().toLowerCase() === host) return true;
  return false;
}

/**
 * Does a live value still agree with what the note wrote down?
 *
 * ADR-002 promised a downward move: a stored value loses authority when a
 * check against its source disagrees. This is that check, and it is the half
 * most systems omit — they let a number go quietly wrong.
 *
 * Compared loosely on purpose. "3%", "3 %" and "3.0%" are the same claim
 * written by three people, and flagging that as a divergence would train
 * everybody to ignore the warning, which costs exactly the cases where it
 * mattered.
 */
export function valuesDiverge(stored: string, live: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '');
  const a = norm(stored);
  const b = norm(live);
  if (a === b) return false;

  // Numbers with the same unit are compared as numbers: "1,000" and "1000"
  // agree, and so do "3%" and "3.0%".
  const split = (v: string) => {
    const m = /^([+-]?[\d.,]+)(.*)$/.exec(v);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? { n, unit: m[2] } : null;
  };
  const na = split(a);
  const nb = split(b);
  if (na && nb && na.unit === nb.unit) return na.n !== nb.n;

  return true;
}
