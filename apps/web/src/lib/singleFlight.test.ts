import { describe, it, expect, vi } from 'vitest';
import { makeSingleFlight } from './singleFlight';

describe('makeSingleFlight', () => {
  it('runs the work once for concurrent calls with the same key', async () => {
    const sf = makeSingleFlight<number>();
    let calls = 0;
    let release!: (n: number) => void;
    const fn = () => {
      calls++;
      return new Promise<number>((res) => {
        release = res;
      });
    };

    // Two "clicks" before the first resolves → must coalesce to one call.
    const a = sf('event sourcing', fn);
    const b = sf('event sourcing', fn);
    release(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(calls).toBe(1); // the bug was: this used to be 2 (duplicate notes)
  });

  it('runs again once the previous call has settled', async () => {
    const sf = makeSingleFlight<string>();
    const fn = vi.fn().mockResolvedValue('ok');
    await sf('k', fn);
    await sf('k', fn);
    expect(fn).toHaveBeenCalledTimes(2); // sequential calls are NOT coalesced
  });

  it('keeps different keys independent', async () => {
    const sf = makeSingleFlight<string>();
    const fn = vi.fn().mockResolvedValue('ok');
    await Promise.all([sf('a', fn), sf('b', fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
