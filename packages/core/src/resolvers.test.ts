import { describe, it, expect, vi } from 'vitest';
import {
  valuesDiverge,
  resolveValue,
  hostAllowed,
  parseResolvers,
  valueAtPath,
  formatResolvedValue,
  ageInWords,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
} from './resolvers';

const block = (body: string) => ['# Nota', '', '```resolver', body, '```', '', 'prosa'].join('\n');

describe('parseResolvers', () => {
  it('reads a declaration out of the note', () => {
    const { resolvers } = parseResolvers(
      block('name: mrr\nurl: https://metrics.example/api/mrr\npath: data.value\nttl: 60'),
    );
    expect(resolvers).toHaveLength(1);
    expect(resolvers[0]).toMatchObject({
      name: 'mrr',
      url: 'https://metrics.example/api/mrr',
      path: 'data.value',
      ttlSeconds: 60,
    });
  });

  it('defaults the ttl rather than refusing the declaration', () => {
    const { resolvers } = parseResolvers(block('name: x\nurl: https://a.example/v'));
    expect(resolvers[0].ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
  });

  it('clamps a ttl that would hammer the source, or freeze the value', () => {
    expect(parseResolvers(block('name: a\nurl: https://a.example\nttl: 1')).resolvers[0].ttlSeconds)
      .toBe(MIN_TTL_SECONDS);
    expect(
      parseResolvers(block('name: a\nurl: https://a.example\nttl: 999999')).resolvers[0].ttlSeconds,
    ).toBe(MAX_TTL_SECONDS);
  });

  it('refuses a scheme that is not http(s), and says why', () => {
    // A note is user input that reaches an HTTP client: `javascript:` and
    // `file:` are URLs too.
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'no soy una url']) {
      const r = parseResolvers(block(`name: a\nurl: ${url}`));
      expect(r.resolvers).toHaveLength(0);
      expect(r.skipped[0].reason).toBe('url-not-http');
    }
  });

  it('a declaration missing its name or url is skipped, not guessed', () => {
    expect(parseResolvers(block('url: https://a.example')).skipped[0].reason).toBe('no-name');
    expect(parseResolvers(block('name: a')).skipped[0].reason).toBe('no-url');
  });

  it('two resolvers with the same name: the second is refused', () => {
    const md = [
      '```resolver',
      'name: mrr',
      'url: https://a.example',
      '```',
      '```resolver',
      'name: mrr',
      'url: https://b.example',
      '```',
    ].join('\n');
    const r = parseResolvers(md);
    // Ambiguity in an answer is worse than a missing value, and the note is
    // the one place to fix it.
    expect(r.resolvers).toHaveLength(1);
    expect(r.resolvers[0].url).toBe('https://a.example/');
    expect(r.skipped[0].reason).toBe('duplicate-name');
  });

  it('reads several declarations and remembers where each one is', () => {
    const md = [
      '```resolver',
      'name: a',
      'url: https://a.example',
      '```',
      'texto',
      '```resolver',
      'name: b',
      'url: https://b.example',
      '```',
    ].join('\n');
    const { resolvers } = parseResolvers(md);
    expect(resolvers.map((r) => r.name)).toEqual(['a', 'b']);
    expect(resolvers[0].line).toBeLessThan(resolvers[1].line);
  });

  it('a pathological line does not make the parser crawl', () => {
    // Regression (CodeQL js/polynomial-redos): the field line used to be
    // matched with `^\s*([a-z_]+)\s*:` , which backtracks polynomially on a
    // line of many spaces — and these lines come out of a note.
    const evil = block(`_:${' '.repeat(50_000)}\nname: a\nurl: https://a.example`);
    const started = Date.now();
    expect(parseResolvers(evil).resolvers).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a note with no resolver block yields none — the common case is free', () => {
    expect(parseResolvers('# Nota\n\nsolo prosa').resolvers).toEqual([]);
  });
});

describe('valueAtPath', () => {
  const body = { data: { value: 42, list: [{ n: 1 }, { n: 2 }] }, top: 'x' };

  it('walks a dotted path, arrays included', () => {
    expect(valueAtPath(body, 'data.value')).toBe(42);
    expect(valueAtPath(body, 'data.list.1.n')).toBe(2);
  });

  it('no path means the body IS the value', () => {
    expect(valueAtPath(7, undefined)).toBe(7);
  });

  it('a path that does not exist is undefined, never a throw', () => {
    expect(valueAtPath(body, 'data.nope.deeper')).toBeUndefined();
    expect(valueAtPath(body, 'top.nope')).toBeUndefined();
  });
});

describe('formatResolvedValue', () => {
  it('renders scalars', () => {
    expect(formatResolvedValue(42)).toBe('42');
    expect(formatResolvedValue('ok')).toBe('ok');
    expect(formatResolvedValue(false)).toBe('false');
  });

  it('refuses an object instead of printing [object Object]', () => {
    // A resolver returning one is pointed at the wrong field, and saying so
    // beats printing noise into an answer.
    expect(formatResolvedValue({ a: 1 })).toBeNull();
    expect(formatResolvedValue([1, 2])).toBeNull();
    expect(formatResolvedValue(null)).toBeNull();
  });
});

describe('ageInWords', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  it('says it in the words that change what a person does', () => {
    expect(ageInWords(new Date('2026-09-02T11:59:30Z'), now)).toBe('30s ago');
    expect(ageInWords(new Date('2026-09-02T11:48:00Z'), now)).toBe('12 minutes ago');
    expect(ageInWords(new Date('2026-09-02T09:00:00Z'), now)).toBe('3 hours ago');
    expect(ageInWords(new Date('2026-08-20T12:00:00Z'), now)).toBe('13 days ago');
  });
});

const spec = {
  name: 'mrr',
  url: 'https://metrics.example/api/mrr',
  path: 'data.value',
  ttlSeconds: 60,
  line: 3,
};

function answering(body: string, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => body,
  }) as unknown as typeof fetch;
}

describe('resolveValue', () => {
  it('returns the value at the declared path', async () => {
    const r = await resolveValue(spec, { fetchImpl: answering('{"data":{"value":42}}') });
    expect(r).toEqual({ ok: true, value: '42' });
  });

  it('accepts a plain-text body — a number in a body is still a value', async () => {
    const r = await resolveValue({ ...spec, path: undefined }, { fetchImpl: answering('42') });
    expect(r).toEqual({ ok: true, value: '42' });
  });

  it('a path that finds nothing is an error the answer can show, not a throw', async () => {
    const r = await resolveValue(spec, { fetchImpl: answering('{"data":{}}') });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/data.value/);
  });

  it('never follows a redirect — one hop undoes the allowlist', async () => {
    const f = answering('{}');
    await resolveValue(spec, { fetchImpl: f });
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.redirect).toBe('error');
  });

  it('sends the operator credential, never one from the note', async () => {
    const f = answering('{"data":{"value":1}}');
    await resolveValue(spec, { fetchImpl: f, token: 'op-token' });
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer op-token');
  });

  it('a source that fails is reported, not thrown', async () => {
    const r = await resolveValue(spec, { fetchImpl: answering('', { ok: false, status: 503 }) });
    expect(r).toEqual({ ok: false, error: 'source answered 503' });
  });

  it('a body over the cap is refused rather than read into memory', async () => {
    const r = await resolveValue(spec, {
      fetchImpl: answering('x'.repeat(200)),
      maxBytes: 100,
    });
    expect(r).toEqual({ ok: false, error: 'response too large' });
  });

  it('a network failure comes back as a message, never as an exception', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    // A search must not fail because a dashboard is down.
    await expect(resolveValue(spec, { fetchImpl: f })).resolves.toMatchObject({ ok: false });
  });
});

describe('hostAllowed', () => {
  it('matches the exact host, port included', () => {
    expect(hostAllowed('https://metrics.example/api', ['metrics.example'])).toBe(true);
    expect(hostAllowed('https://metrics.example:8443/api', ['metrics.example:8443'])).toBe(true);
    expect(hostAllowed('https://metrics.example:8443/api', ['metrics.example'])).toBe(false);
  });

  it('never matches a suffix — that is how this check is got wrong', () => {
    expect(hostAllowed('https://metrics.example.attacker.com/x', ['example.com'])).toBe(false);
    expect(hostAllowed('https://notexample.com/x', ['example.com'])).toBe(false);
  });

  it('a URL that does not parse is not allowed', () => {
    expect(hostAllowed('no soy una url', ['example.com'])).toBe(false);
  });
});

describe('valuesDiverge', () => {
  it('the same claim written differently is NOT a divergence', () => {
    // Flagging "3%" against "3 %" trains everybody to ignore the warning,
    // which costs exactly the cases where it mattered.
    expect(valuesDiverge('3%', '3 %')).toBe(false);
    expect(valuesDiverge('3%', '3.0%')).toBe(false);
    expect(valuesDiverge('1,000', '1000')).toBe(false);
    expect(valuesDiverge('OK', 'ok')).toBe(false);
  });

  it('a different number is a divergence', () => {
    expect(valuesDiverge('3%', '4%')).toBe(true);
    expect(valuesDiverge('1000', '1001')).toBe(true);
  });

  it('the same number with a different unit is a divergence', () => {
    // 42 USD and 42 EUR are not the same claim, and pretending otherwise is
    // the kind of quiet wrongness this check exists to catch.
    expect(valuesDiverge('42 USD', '42 EUR')).toBe(true);
  });

  it('a pathological value does not make the comparison crawl', () => {
    // Regression (CodeQL js/polynomial-redos): both sides are untrusted — one
    // comes from a note, the other from a remote source.
    const evil = ','.repeat(50_000);
    const started = Date.now();
    expect(valuesDiverge(evil, 'x')).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('text that simply differs is a divergence', () => {
    expect(valuesDiverge('open', 'closed')).toBe(true);
  });
});
