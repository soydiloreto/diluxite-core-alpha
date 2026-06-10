import { describe, it, expect } from 'vitest';
import { mcpSessionExpired, MCP_SESSION_TTL_MS } from './mcp';

/**
 * #11g — the TTL sweep must never evict a session that has an SSE stream open,
 * even if `lastSeenAt` is far past the TTL. Once the stream closes (openStreams
 * back to 0) the session ages out normally.
 */
describe('mcpSessionExpired — open-stream guard (#11g)', () => {
  const now = 1_000_000_000_000;

  it('idle session past the TTL with no stream → expired', () => {
    expect(
      mcpSessionExpired({ lastSeenAt: now - MCP_SESSION_TTL_MS - 1, openStreams: 0 }, now),
    ).toBe(true);
  });

  it('idle session within the TTL → not expired', () => {
    expect(
      mcpSessionExpired({ lastSeenAt: now - 1000, openStreams: 0 }, now),
    ).toBe(false);
  });

  it('past the TTL but with an open SSE stream → NOT expired (the fix)', () => {
    expect(
      mcpSessionExpired({ lastSeenAt: now - MCP_SESSION_TTL_MS * 10, openStreams: 1 }, now),
    ).toBe(false);
  });

  it('multiple open streams keep the session alive', () => {
    expect(
      mcpSessionExpired({ lastSeenAt: now - MCP_SESSION_TTL_MS * 100, openStreams: 3 }, now),
    ).toBe(false);
  });

  it('once the last stream closes, an idle past-TTL session is reclaimable again', () => {
    const lastSeenAt = now - MCP_SESSION_TTL_MS - 1;
    expect(mcpSessionExpired({ lastSeenAt, openStreams: 1 }, now)).toBe(false);
    expect(mcpSessionExpired({ lastSeenAt, openStreams: 0 }, now)).toBe(true);
  });
});
