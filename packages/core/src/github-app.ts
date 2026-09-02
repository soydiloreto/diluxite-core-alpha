import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

/**
 * GitHub App authentication — the credential half of ingestion v1.1.
 *
 * WHY AN APP AND NOT A TOKEN, since this is the decision everything else
 * follows from: a personal access token is one person's key. Under SAML it has
 * to be authorised per organisation and it dies when that person leaves or
 * their SSO is revoked — so the company's ingestion stops because somebody
 * changed jobs. An App's installation token belongs to the organisation, is
 * scoped to the repositories an owner picked, and lasts an hour.
 *
 * And on our side the difference is larger still: with tokens, this server
 * would store N long-lived, broad credentials belonging to other people. With
 * an App it stores ONE private key of ours plus, per customer, an
 * `installation_id` — which is not a credential at all.
 *
 * No SDK: two signatures and three HTTP calls do not justify a dependency that
 * ships its own auth stack, which is the same reasoning the Bedrock embedding
 * provider is built on.
 */

/** How long an app JWT is valid. GitHub refuses anything over ten minutes. */
export const APP_JWT_TTL_SECONDS = 9 * 60;

/**
 * The JWT that proves we are the App — signed with its private key, RS256.
 *
 * `iat` is backdated by a minute on purpose: GitHub rejects a token whose
 * `iat` is in the future, and a server clock that runs a few seconds fast is
 * ordinary. Losing a minute of validity costs nothing; failing every request
 * on a machine with drifting time costs a day of debugging.
 */
export function appJwt(
  appId: string,
  privateKeyPem: string,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp: iat + APP_JWT_TTL_SECONDS, iss: appId };
  const encode = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${b64url(signer.sign(privateKeyPem))}`;
}

function b64url(buf: Buffer): string {
  // `replaceAll('=')` rather than `/=+$/`: base64 padding only ever appears at
  // the end, so the two are equivalent here — and the anchored-repetition form
  // backtracks polynomially on a string of '=', which CodeQL is right to
  // flag even when the input is ours today.
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Is this webhook really from GitHub?
 *
 * HMAC-SHA256 over the RAW body — the exact bytes, before any JSON parse.
 * Re-serialising the parsed object changes key order and whitespace and the
 * signature stops matching, which is the classic way this check is broken
 * while looking correct.
 *
 * Compared in constant time: a plain `===` leaks how much of the signature is
 * right, one byte at a time.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  );
  const given = Buffer.from(signatureHeader);
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Which files are worth ingesting from a repository. */
export function isIngestablePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.md') && !lower.endsWith('.mdx')) return false;
  // Vendored trees are somebody else's documentation: ingesting them buries
  // the company's own writing under a dependency's changelog.
  const skip = ['node_modules/', 'vendor/', '.git/', 'dist/', 'build/', 'coverage/'];
  return !skip.some((s) => lower.includes(s));
}

/** A file, as GitHub's tree API describes it. */
export interface GithubTreeFile {
  path: string;
  sha: string;
  size?: number;
}

/**
 * What actually has to be fetched, given what is already ingested.
 *
 * The incremental contract, and it is the whole reason a push does not cost a
 * full re-read: git's blob sha IS the content hash, so a file whose sha
 * matches what the note recorded cannot have changed. Same contract the DDW
 * connector already runs on.
 */
export function planIngestion(
  files: GithubTreeFile[],
  known: Map<string, string>,
  maxBytes = 256 * 1024,
): { fetch: GithubTreeFile[]; unchanged: string[]; gone: string[]; tooLarge: string[] } {
  const fetchList: GithubTreeFile[] = [];
  const unchanged: string[] = [];
  const tooLarge: string[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    if (!isIngestablePath(f.path)) continue;
    seen.add(f.path);
    if (f.size !== undefined && f.size > maxBytes) {
      // A megabyte of generated Markdown is a build artifact, not a document.
      tooLarge.push(f.path);
      continue;
    }
    if (known.get(f.path) === f.sha) {
      unchanged.push(f.path);
      continue;
    }
    fetchList.push(f);
  }

  // A file that vanished from the repo gets ANNOTATED, never trashed — the
  // house rule the DDW connector already follows. Deleting it would erase the
  // record that it once said something.
  const gone = [...known.keys()].filter((p) => !seen.has(p));
  return { fetch: fetchList, unchanged, gone, tooLarge };
}
