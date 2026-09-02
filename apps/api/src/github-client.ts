import { appJwt } from '@diluxite/core';

/**
 * The three GitHub calls ingestion needs, and nothing else.
 *
 * No SDK: an installation token, a tree listing and a blob read do not justify
 * a dependency that ships its own auth stack — the same reasoning behind the
 * Bedrock embedding provider.
 *
 * Every call goes through one place so the two things that must always be true
 * are true once: a timeout (GitHub having a bad day must not hold a request)
 * and a version header (the REST API changes under unversioned clients).
 */

const API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const VERSION = '2022-11-28';

export interface GithubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export class GithubClient {
  constructor(
    private readonly creds: GithubAppCredentials,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  private async call<T>(path: string, token: string, accept = ACCEPT): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const res = await f(`${API}${path}`, {
        method: path.startsWith('/app/installations') ? 'POST' : 'GET',
        signal: controller.signal,
        headers: {
          accept,
          authorization: `Bearer ${token}`,
          'x-github-api-version': VERSION,
          'user-agent': 'diluxite',
        },
      });
      if (!res.ok) {
        // The status matters to the caller: 401 means our key or the
        // installation is gone (stop and say so), 403 with a rate-limit header
        // means try later. Swallowing them into one Error loses that.
        throw new GithubError(res.status, `GitHub answered ${res.status} for ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * An installation access token: the credential that belongs to the
   * organisation rather than to a person. Lasts an hour, scoped to the repos
   * the installation granted. Never stored — minted per run.
   */
  async installationToken(installationId: string): Promise<{ token: string; expiresAt: string }> {
    const jwt = appJwt(this.creds.appId, this.creds.privateKeyPem);
    const body = await this.call<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
    );
    return { token: body.token, expiresAt: body.expires_at };
  }

  /** The repositories this installation was granted. Not "all their repos". */
  async installationRepos(token: string): Promise<GithubRepo[]> {
    const body = await this.call<{
      repositories: { full_name: string; default_branch: string; private: boolean }[];
    }>('/installation/repositories?per_page=100', token);
    return body.repositories.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    }));
  }

  /**
   * Every file in a ref, in one call.
   *
   * `recursive=1` because the alternative is a request per directory, and a
   * documentation tree is mostly directories. GitHub truncates very large
   * trees and says so — reported rather than silently half-ingested.
   */
  async tree(
    token: string,
    fullName: string,
    ref: string,
  ): Promise<{ files: { path: string; sha: string; size?: number }[]; truncated: boolean }> {
    const body = await this.call<{
      tree: { path: string; sha: string; type: string; size?: number }[];
      truncated: boolean;
    }>(`/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token);
    return {
      files: body.tree
        .filter((t) => t.type === 'blob')
        .map((t) => ({ path: t.path, sha: t.sha, size: t.size })),
      truncated: body.truncated,
    };
  }

  /** One file's content, by blob sha — which is also its identity. */
  async blob(token: string, fullName: string, sha: string): Promise<string> {
    const body = await this.call<{ content: string; encoding: string }>(
      `/repos/${fullName}/git/blobs/${sha}`,
      token,
    );
    if (body.encoding !== 'base64') throw new GithubError(422, `unexpected encoding ${body.encoding}`);
    return Buffer.from(body.content, 'base64').toString('utf8');
  }
}

/** Carries the status, because 401 and 403 mean different things to a caller. */
export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}
