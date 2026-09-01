import { describe, it, expect } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  MeteredEmbeddingProvider,
  MetricsRegistry,
} from './metrics';

describe('metrics exposition', () => {
  it('renders a counter with its help and type, once per family', () => {
    const c = new Counter('http_requests_total', 'Requests handled.');
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'GET', status: '200' }, 2);
    c.inc({ method: 'POST', status: '201' });
    const out = c.render();
    expect(out.split('\n')[0]).toBe('# HELP http_requests_total Requests handled.');
    expect(out.split('\n')[1]).toBe('# TYPE http_requests_total counter');
    expect(out).toContain('http_requests_total{method="GET",status="200"} 3');
    expect(out).toContain('http_requests_total{method="POST",status="201"} 1');
    // One family, one HELP.
    expect(out.match(/# HELP/g)).toHaveLength(1);
  });

  it('treats label sets as unordered — one series, not two', () => {
    const c = new Counter('c_total', 'x');
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });
    expect(c.render()).toContain('c_total{a="1",b="2"} 2');
  });

  it('escapes what the format reserves in a label value', () => {
    // A route label can carry a quote if someone routes on user input, and an
    // unescaped one silently truncates the series.
    const c = new Counter('c_total', 'x');
    c.inc({ route: 'a"b\\c\nd' });
    expect(c.render()).toContain('c_total{route="a\\"b\\\\c\\nd"} 1');
  });

  it('refuses to decrease a counter', () => {
    const c = new Counter('c_total', 'x');
    expect(() => c.inc({}, -1)).toThrow(/cannot decrease/);
  });

  it('refuses a name the format cannot carry', () => {
    expect(() => new Counter('has-dashes', 'x')).toThrow(/invalid metric name/);
  });

  it('renders a histogram as cumulative buckets plus sum and count', () => {
    const h = new Histogram('dur_seconds', 'How long.', [0.1, 1]);
    h.observe({ route: '/a' }, 0.05);
    h.observe({ route: '/a' }, 0.5);
    h.observe({ route: '/a' }, 5);
    const out = h.render();
    expect(out).toContain('dur_seconds_bucket{le="0.1",route="/a"} 1');
    // Cumulative: the 0.05 and the 0.5 are both ≤ 1.
    expect(out).toContain('dur_seconds_bucket{le="1",route="/a"} 2');
    expect(out).toContain('dur_seconds_bucket{le="+Inf",route="/a"} 3');
    expect(out).toContain('dur_seconds_sum{route="/a"} 5.55');
    expect(out).toContain('dur_seconds_count{route="/a"} 3');
  });

  it('refuses buckets that do not ascend', () => {
    // Cumulative rendering assumes ordering; unsorted bounds parse and lie.
    expect(() => new Histogram('h', 'x', [1, 0.5])).toThrow(/ascend/);
  });

  it('reads a gauge when the scrape arrives, not when someone remembered', () => {
    let now = 1;
    const g = new Gauge('uptime_seconds', 'x', () => now);
    expect(g.render()).toContain('uptime_seconds 1');
    now = 42;
    expect(g.render()).toContain('uptime_seconds 42');
  });

  it('hands back the same metric when a name is registered twice', () => {
    // Two objects under one name would split the observations and emit the
    // family twice, which a scraper rejects.
    const reg = new MetricsRegistry();
    const a = reg.counter('c_total', 'x');
    const b = reg.counter('c_total', 'different help');
    expect(b).toBe(a);
    a.inc({});
    b.inc({});
    expect(reg.render().match(/# TYPE c_total/g)).toHaveLength(1);
    expect(reg.render()).toContain('c_total 2');
  });

  it('ends the exposition with a newline, and an empty registry with nothing', () => {
    const reg = new MetricsRegistry();
    expect(reg.render()).toBe('');
    reg.counter('c_total', 'x').inc({});
    expect(reg.render().endsWith('\n')).toBe(true);
  });
});

describe('MeteredEmbeddingProvider', () => {
  const registry = () => new MetricsRegistry();

  it('counts calls, texts and duration, and keeps the vectors intact', async () => {
    const reg = registry();
    const inner = {
      dimensions: 3,
      embed: async (t: string[]) => t.map(() => [1, 2, 3]),
    };
    const metered = new MeteredEmbeddingProvider(inner, reg, 'ollama');
    expect(metered.dimensions).toBe(3);
    expect(await metered.embed(['a', 'b'])).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    const out = reg.render();
    expect(out).toContain('diluxite_embedding_calls_total{outcome="ok",provider="ollama"} 1');
    expect(out).toContain('diluxite_embedding_texts_total{provider="ollama"} 2');
    expect(out).toContain('diluxite_embedding_duration_seconds_count{provider="ollama"} 1');
  });

  it('counts a failure and re-throws it untouched', async () => {
    // A wrapper that swallows what it measures turns an outage into silence.
    const reg = registry();
    const boom = new Error('endpoint refused');
    const metered = new MeteredEmbeddingProvider(
      {
        dimensions: 1,
        embed: async () => {
          throw boom;
        },
      },
      reg,
      'azure',
    );
    await expect(metered.embed(['x'])).rejects.toBe(boom);
    const out = reg.render();
    expect(out).toContain('diluxite_embedding_calls_total{outcome="error",provider="azure"} 1');
    // The failed call still took time, and that time is the interesting one.
    expect(out).toContain('diluxite_embedding_duration_seconds_count{provider="azure"} 1');
    expect(out).not.toContain('diluxite_embedding_texts_total');
  });

  it('says nothing about a provider that describes nothing', () => {
    // `describe` is optional in the port. Answering with an invented
    // description would tell the console "not semantic" when the truth is
    // "did not say".
    const plain = new MeteredEmbeddingProvider(
      { dimensions: 1, embed: async () => [[0]] },
      registry(),
      'local',
    );
    expect(plain.describe).toBeUndefined();

    const described = new MeteredEmbeddingProvider(
      {
        dimensions: 1,
        embed: async () => [[0]],
        describe: () => ({
          provider: 'azure',
          semantic: true,
          dimensions: 1,
          model: 'm',
          endpoint: 'https://x',
        }),
      },
      registry(),
      'azure',
    );
    expect(described.describe?.()).toMatchObject({ provider: 'azure', semantic: true });
  });
});
