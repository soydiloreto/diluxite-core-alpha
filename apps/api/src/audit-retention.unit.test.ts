import { describe, it, expect, vi } from 'vitest';
import { startAuditRetention } from './audit-retention';
import type { DrizzleAuditEventsRepository } from '@diluxite/db';

/**
 * Tests del retention sweeper. Cubrimos:
 *  - retentionDays <= 0 → no-op handle (stop/runOnce safe to call).
 *  - runOnce calcula cutoff = now - N days y llama deleteOlderThan con ese Date.
 *  - El sweep periódico llama deleteOlderThan repetidamente.
 *  - Si deleteOlderThan throwea, NO crashea el process — solo loguea.
 *  - stop() cancela el timer (el siguiente intervalo no dispara).
 */

function fakeAudit(deleteFn?: () => Promise<number> | number): DrizzleAuditEventsRepository {
  return {
    deleteOlderThan: vi.fn(deleteFn ?? (async () => 0)),
  } as unknown as DrizzleAuditEventsRepository;
}

describe('startAuditRetention', () => {
  it('returns a no-op handle when retentionDays <= 0', async () => {
    const audit = fakeAudit();
    const h = startAuditRetention(audit, { retentionDays: 0 });
    expect(await h.runOnce()).toBe(0);
    h.stop();
    expect(audit.deleteOlderThan).not.toHaveBeenCalled();
  });

  it('runOnce calls deleteOlderThan with a Date N days in the past', async () => {
    const audit = fakeAudit(async () => 5);
    const fixedNow = new Date('2026-06-02T12:00:00Z');
    const h = startAuditRetention(audit, {
      retentionDays: 30,
      now: () => fixedNow,
    });
    const deleted = await h.runOnce();
    expect(deleted).toBe(5);
    expect(audit.deleteOlderThan).toHaveBeenCalledTimes(1);
    const cutoff = (audit.deleteOlderThan as unknown as { mock: { calls: [Date][] } }).mock.calls[0][0];
    expect(cutoff).toBeInstanceOf(Date);
    const expected = new Date(fixedNow.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBe(expected.getTime());
    h.stop();
  });

  it('the interval triggers sweep repeatedly', async () => {
    vi.useFakeTimers();
    try {
      const audit = fakeAudit(async () => 0);
      const h = startAuditRetention(audit, {
        retentionDays: 30,
        intervalMs: 1000,
      });
      // Two ticks.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(audit.deleteOlderThan).toHaveBeenCalledTimes(2);
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deleteOlderThan failure does not propagate or crash the loop', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const audit = fakeAudit(async () => {
        throw new Error('db down');
      });
      const h = startAuditRetention(audit, { retentionDays: 1, intervalMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      // The sweep ran twice, both failed silently — no rejection bubbled up.
      expect(audit.deleteOlderThan).toHaveBeenCalledTimes(2);
      // We DID log the failure so operators can investigate.
      expect(errSpy).toHaveBeenCalled();
      h.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stop() cancels the timer (no further sweeps)', async () => {
    vi.useFakeTimers();
    try {
      const audit = fakeAudit(async () => 0);
      const h = startAuditRetention(audit, { retentionDays: 1, intervalMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      const after1 = (audit.deleteOlderThan as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .length;
      h.stop();
      await vi.advanceTimersByTimeAsync(1000);
      const after2 = (audit.deleteOlderThan as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .length;
      expect(after2).toBe(after1); // nothing new after stop.
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs when deletions occur (positive count)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const audit = fakeAudit(async () => 42);
      const h = startAuditRetention(audit, { retentionDays: 7 });
      await h.runOnce();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/audit-retention.*42/));
      h.stop();
    } finally {
      logSpy.mockRestore();
    }
  });
});
