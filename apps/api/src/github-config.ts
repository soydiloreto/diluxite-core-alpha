/**
 * The GitHub App's own credentials — the operator's, not a customer's.
 *
 * One App serves every organisation on this installation, which is the shape
 * ADR-less-but-decided on 1-Sep: the customer installs it, the operator owns
 * it. So this reads from the environment rather than from a per-org table:
 * putting it in the database would imply each organisation registers its own
 * App, which is exactly the friction the App model removes.
 *
 * Absent means the connector is simply not offered — a working state, and the
 * one every self-hosted install is in.
 */

export interface GithubAppConfig {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  /** The App's slug, for the install URL somebody is sent to. */
  slug: string;
}

export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig | null {
  const appId = env.DILUXITE_GITHUB_APP_ID;
  // Accepts the PEM with real newlines or with the `\n` an env file forces —
  // a key pasted into a .env is the ordinary case, and failing on it produces
  // an unreadable crypto error instead of a useful one.
  const key = env.DILUXITE_GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const secret = env.DILUXITE_GITHUB_WEBHOOK_SECRET;
  const slug = env.DILUXITE_GITHUB_APP_SLUG;
  if (!appId || !key || !secret || !slug) return null;
  return { appId, privateKeyPem: key, webhookSecret: secret, slug };
}

/** Where a person is sent to install it. `state` brings them back to their org. */
export function installUrl(slug: string, orgId: string): string {
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(orgId)}`;
}
