import { describe, it, expect } from 'vitest';
import { canReadSpace, canWriteSpace, type SpaceAuthzDeps } from './space-authz';
import type { Identity } from './auth';

/**
 * The rule that decides who may read and who may write a workspace.
 *
 * It is unit-tested here, without a database, because it is pure policy over
 * two ports — and because it went wrong twice in exactly the way an
 * integration test on ONE surface cannot catch: REST enforced the role while
 * MCP and the collab socket each answered their own version of the question.
 * These cases pin the rule itself; the integration tests then pin that each
 * surface actually calls it.
 */

const SPACE = 'space-1';
const ORG = 'org-1';

/** A stub over the two ports. `members` maps userId → workspace role. */
function deps(opts: {
  members?: Record<string, string>;
  orgRoles?: Record<string, string>;
  spaceOrg?: string | null;
}): SpaceAuthzDeps {
  const members = opts.members ?? {};
  const orgRoles = opts.orgRoles ?? {};
  const spaceOrg = opts.spaceOrg === undefined ? ORG : opts.spaceOrg;
  return {
    spaces: {
      isMember: async (spaceId, userId) => spaceId === SPACE && userId in members,
      isSpaceInOrg: async (spaceId, orgId) => spaceId === SPACE && orgId === ORG,
      role: async (spaceId, userId) => (spaceId === SPACE ? (members[userId] ?? null) : null),
      findById: async (spaceId) =>
        spaceId === SPACE && spaceOrg !== null ? { orgId: spaceOrg } : null,
    },
    organizations: {
      roleOf: async (orgId, userId) => (orgId === spaceOrg ? (orgRoles[userId] ?? null) : null),
    },
  };
}

const user = (userId: string): Identity => ({ kind: 'user', userId });
const orgToken = (scopes: string[]): Identity => ({
  kind: 'org',
  orgId: ORG,
  tokenId: 'tok-1',
  scopes,
});

describe('canReadSpace', () => {
  it('lets any member read, viewer included', async () => {
    const d = deps({ members: { ana: 'viewer', beto: 'editor', caro: 'admin' } });
    for (const who of ['ana', 'beto', 'caro']) {
      expect(await canReadSpace(d, user(who), SPACE)).toBe(true);
    }
  });

  it('refuses a non-member', async () => {
    const d = deps({ members: { ana: 'admin' } });
    expect(await canReadSpace(d, user('intruso'), SPACE)).toBe(false);
  });

  it('lets an org token with the read scope reach its own org space', async () => {
    const d = deps({});
    expect(await canReadSpace(d, orgToken(['read']), SPACE)).toBe(true);
  });

  it('refuses an org token that carries neither scope', async () => {
    const d = deps({});
    expect(await canReadSpace(d, orgToken([]), SPACE)).toBe(false);
  });

  it('refuses an org token whose org does not own the space', async () => {
    const d = deps({});
    const foreign: Identity = { kind: 'org', orgId: 'otra-org', tokenId: 't', scopes: ['read'] };
    expect(await canReadSpace(d, foreign, SPACE)).toBe(false);
  });
});

describe('canWriteSpace', () => {
  it('lets admin and editor write', async () => {
    const d = deps({ members: { beto: 'editor', caro: 'admin' } });
    expect(await canWriteSpace(d, user('beto'), SPACE)).toBe(true);
    expect(await canWriteSpace(d, user('caro'), SPACE)).toBe(true);
  });

  // THE regression. A viewer reads and does not write — and used to write
  // through MCP and through the collab socket while REST said 403.
  it('refuses a viewer, who can still read', async () => {
    const d = deps({ members: { ana: 'viewer' } });
    expect(await canReadSpace(d, user('ana'), SPACE)).toBe(true);
    expect(await canWriteSpace(d, user('ana'), SPACE)).toBe(false);
  });

  it('refuses a non-member outright', async () => {
    const d = deps({ members: { caro: 'admin' } });
    expect(await canWriteSpace(d, user('intruso'), SPACE)).toBe(false);
  });

  it('escalates an org admin to workspace write without a direct membership', async () => {
    const d = deps({ members: {}, orgRoles: { jefa: 'org_admin' } });
    expect(await canWriteSpace(d, user('jefa'), SPACE)).toBe(true);
  });

  it('escalates a org_admin the same way', async () => {
    const d = deps({ members: {}, orgRoles: { root: 'org_admin' } });
    expect(await canWriteSpace(d, user('root'), SPACE)).toBe(true);
  });

  it('lets an org admin override their own lower workspace role', async () => {
    // A viewer membership must not cap someone who administers the org — this
    // mirrors the control-plane's `requireWorkspaceRole` escalation.
    const d = deps({ members: { jefa: 'viewer' }, orgRoles: { jefa: 'org_admin' } });
    expect(await canWriteSpace(d, user('jefa'), SPACE)).toBe(true);
  });

  it('does NOT escalate a plain org member', async () => {
    const d = deps({ members: {}, orgRoles: { pepe: 'org_member' } });
    expect(await canWriteSpace(d, user('pepe'), SPACE)).toBe(false);
  });

  it('honours a legacy role value as read-only rather than guessing', async () => {
    // Pre-v4.1 installs carry an `owner` role. It is not in the write list, so
    // such a member only writes via the org-admin escalation — deliberately,
    // because inventing a mapping here would be a silent privilege decision.
    const d = deps({ members: { viejo: 'owner' } });
    expect(await canWriteSpace(d, user('viejo'), SPACE)).toBe(false);
  });

  it('requires the write scope for an org token', async () => {
    const d = deps({});
    expect(await canWriteSpace(d, orgToken(['write']), SPACE)).toBe(true);
    expect(await canWriteSpace(d, orgToken(['read']), SPACE)).toBe(false);
    expect(await canWriteSpace(d, orgToken(['read', 'write']), SPACE)).toBe(true);
  });

  it('refuses when the space has no org row to escalate through', async () => {
    const d = deps({ members: {}, orgRoles: { jefa: 'org_admin' }, spaceOrg: null });
    expect(await canWriteSpace(d, user('jefa'), SPACE)).toBe(false);
  });
});
