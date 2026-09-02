import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { githubInstallations, githubRepoFiles } from './schema';

export interface GithubInstallation {
  orgId: string;
  installationId: string;
  accountLogin: string | null;
  spaceId: string | null;
  connectedAt: Date;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}

/**
 * The GitHub connection and what has been ingested from it (migration 0043).
 *
 * One installation per organisation. Not per repository: an installation
 * already carries which repositories an owner granted, and duplicating that
 * here would be a second copy of a decision GitHub owns.
 */
export class DrizzleGithubRepository {
  constructor(private readonly db: Db) {}

  async installationFor(orgId: string): Promise<GithubInstallation | null> {
    const [row] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.orgId, orgId))
      .limit(1);
    return row ?? null;
  }

  /** Which organisation an installation belongs to — the webhook's only read. */
  async orgForInstallation(installationId: string): Promise<GithubInstallation | null> {
    const [row] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    return row ?? null;
  }

  async connect(input: {
    orgId: string;
    installationId: string;
    accountLogin?: string | null;
    spaceId?: string | null;
    connectedBy?: string | null;
  }): Promise<GithubInstallation> {
    await this.db
      .insert(githubInstallations)
      .values({
        orgId: input.orgId,
        installationId: input.installationId,
        accountLogin: input.accountLogin ?? null,
        spaceId: input.spaceId ?? null,
        connectedBy: input.connectedBy ?? null,
      })
      .onConflictDoUpdate({
        target: githubInstallations.orgId,
        set: {
          installationId: input.installationId,
          accountLogin: input.accountLogin ?? null,
          spaceId: input.spaceId ?? null,
          connectedBy: input.connectedBy ?? null,
          // Re-connecting clears the last error: whatever was wrong is the
          // reason somebody re-connected, and showing it afterwards reads as
          // "it is still broken".
          lastSyncError: null,
        },
      });
    return (await this.installationFor(input.orgId))!;
  }

  /**
   * Disconnect.
   *
   * The ingested notes STAY. They are the organisation's writing, not
   * GitHub's, and deleting somebody's documentation because a connector was
   * switched off is not a decision a connector gets to make. The file records
   * go, so a later re-connect re-ingests from scratch rather than trusting
   * shas nobody has checked since.
   */
  async disconnect(orgId: string): Promise<void> {
    await this.db.delete(githubRepoFiles).where(eq(githubRepoFiles.orgId, orgId));
    await this.db.delete(githubInstallations).where(eq(githubInstallations.orgId, orgId));
  }

  async recordSync(orgId: string, error: string | null): Promise<void> {
    await this.db
      .update(githubInstallations)
      .set({ lastSyncAt: new Date(), lastSyncError: error })
      .where(eq(githubInstallations.orgId, orgId));
  }

  /** What is already ingested from one repo: path → blob sha. */
  async knownFiles(orgId: string, fullName: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ path: githubRepoFiles.path, blobSha: githubRepoFiles.blobSha })
      .from(githubRepoFiles)
      .where(and(eq(githubRepoFiles.orgId, orgId), eq(githubRepoFiles.fullName, fullName)));
    return new Map(rows.map((r) => [r.path, r.blobSha]));
  }

  async recordFile(input: {
    orgId: string;
    fullName: string;
    path: string;
    blobSha: string;
    noteId: string;
  }): Promise<void> {
    await this.db
      .insert(githubRepoFiles)
      .values(input)
      .onConflictDoUpdate({
        target: [githubRepoFiles.orgId, githubRepoFiles.fullName, githubRepoFiles.path],
        set: { blobSha: input.blobSha, noteId: input.noteId, ingestedAt: new Date() },
      });
  }

  /** Forget files that are gone from the repo. Their notes are NOT deleted. */
  async forgetFiles(orgId: string, fullName: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.db
      .delete(githubRepoFiles)
      .where(
        and(
          eq(githubRepoFiles.orgId, orgId),
          eq(githubRepoFiles.fullName, fullName),
          inArray(githubRepoFiles.path, paths),
        ),
      );
  }

  /** The note a path was ingested into, so a vanished file can be annotated. */
  async noteFor(orgId: string, fullName: string, path: string): Promise<string | null> {
    const [row] = await this.db
      .select({ noteId: githubRepoFiles.noteId })
      .from(githubRepoFiles)
      .where(
        and(
          eq(githubRepoFiles.orgId, orgId),
          eq(githubRepoFiles.fullName, fullName),
          eq(githubRepoFiles.path, path),
        ),
      )
      .limit(1);
    return row?.noteId ?? null;
  }
}
