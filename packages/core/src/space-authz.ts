import {
  TOKEN_SCOPE_READ,
  TOKEN_SCOPE_WRITE,
  type Identity,
  type SpaceAccess,
} from './auth';

/**
 * Who may read and who may write a workspace — the single definition.
 *
 * This lives in core, as pure policy over ports, because it has THREE callers
 * and used to have three answers. The REST layer enforced the workspace role;
 * MCP checked membership only, so a `viewer` could create, edit and delete
 * notes through an agent while the same account got a 403 from the web app;
 * and the collab WebSocket checked membership only AND ignored org-token
 * scopes entirely, so a read-only token could have typed into a live document.
 * Two surfaces, two silent bypasses of the same rule, because the rule was a
 * closure inside `buildApp` that neither of them could reach.
 *
 * The rule is now written once and imported. Anything that authorises a
 * data-plane operation on a space calls these two functions, and a new
 * surface gets the behaviour by construction rather than by remembering.
 */

/** Workspace roles allowed to MUTATE. A `viewer` reads and nothing else. */
export const WORKSPACE_WRITE_ROLES: readonly string[] = ['admin', 'editor'];

/**
 * Org roles that act with workspace-admin authority over every space in their
 * org, whether or not they hold a (sufficient) direct membership.
 */
export const ORG_ADMIN_ROLES: readonly string[] = ['super_admin', 'admin'];

/**
 * The ports this policy needs. `spaces` is the core `SpaceAccess` plus the
 * space→org lookup the escalation rule requires; `organizations` answers the
 * caller's role in that org. Both are satisfied by the Drizzle repositories.
 */
export interface SpaceAuthzDeps {
  spaces: Pick<SpaceAccess, 'isMember' | 'isSpaceInOrg' | 'role'> & {
    findById(spaceId: string): Promise<{ orgId: string } | null>;
  };
  organizations: {
    roleOf(orgId: string, userId: string): Promise<string | null>;
  };
}

/**
 * READ access. A user must be a member of the space, at any role — `viewer`
 * included, which is the whole point of that role. An org token must carry
 * the `read` scope AND own the space's org.
 */
export async function canReadSpace(
  deps: SpaceAuthzDeps,
  identity: Identity,
  spaceId: string,
): Promise<boolean> {
  if (identity.kind === 'user') {
    return deps.spaces.isMember(spaceId, identity.userId);
  }
  return (
    identity.scopes.includes(TOKEN_SCOPE_READ) &&
    (await deps.spaces.isSpaceInOrg(spaceId, identity.orgId))
  );
}

/**
 * WRITE access. A user needs a direct `admin`/`editor` membership, OR to be an
 * admin of the space's org (which escalates to workspace admin — the same
 * rule the control-plane routes apply, and the reason a legacy `owner` role
 * from a pre-v4.1 install still works). An org token needs the `write` scope
 * AND to own the space's org; the `read` scope alone is not enough anywhere.
 */
export async function canWriteSpace(
  deps: SpaceAuthzDeps,
  identity: Identity,
  spaceId: string,
): Promise<boolean> {
  if (identity.kind !== 'user') {
    return (
      identity.scopes.includes(TOKEN_SCOPE_WRITE) &&
      (await deps.spaces.isSpaceInOrg(spaceId, identity.orgId))
    );
  }
  const directRole = await deps.spaces.role(spaceId, identity.userId);
  if (directRole && WORKSPACE_WRITE_ROLES.includes(directRole)) return true;
  const space = await deps.spaces.findById(spaceId);
  if (!space) return false;
  const orgRole = await deps.organizations.roleOf(space.orgId, identity.userId);
  return orgRole !== null && ORG_ADMIN_ROLES.includes(orgRole);
}
