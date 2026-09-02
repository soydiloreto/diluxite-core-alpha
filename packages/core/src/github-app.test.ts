import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify, createHmac } from 'node:crypto';
import {
  appJwt,
  verifyWebhookSignature,
  isIngestablePath,
  planIngestion,
  APP_JWT_TTL_SECONDS,
} from './github-app';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decode(part: string) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

describe('appJwt', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');

  it('is signed with the app key and verifies against its public half', () => {
    const jwt = appJwt('123', PEM, now);
    const [h, p, sig] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))).toBe(true);
  });

  it('claims the app as issuer and expires inside GitHub‘s ten minutes', () => {
    const { iss, iat, exp } = decode(appJwt('123', PEM, now).split('.')[1]);
    expect(iss).toBe('123');
    expect(exp - iat).toBe(APP_JWT_TTL_SECONDS);
    expect(exp - Math.floor(now.getTime() / 1000)).toBeLessThan(600);
  });

  it('backdates iat by a minute so a fast clock does not fail every request', () => {
    // GitHub rejects a token whose iat is in the future, and a server clock
    // running a few seconds fast is ordinary.
    const { iat } = decode(appJwt('123', PEM, now).split('.')[1]);
    expect(iat).toBe(Math.floor(now.getTime() / 1000) - 60);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'un-secreto';
  const body = '{"action":"push","after":"abc"}';
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a signature over the RAW body', () => {
    expect(verifyWebhookSignature(secret, body, good)).toBe(true);
  });

  it('rejects a body that was re-serialised', () => {
    // Key order and whitespace change, the signature stops matching — the
    // classic way this check is broken while looking correct.
    const reserialised = JSON.stringify(JSON.parse(body));
    expect(verifyWebhookSignature(secret, `${reserialised} `, good)).toBe(false);
  });

  it('rejects a wrong secret, a missing header and a wrong scheme', () => {
    expect(verifyWebhookSignature('otro', body, good)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, good.replace('sha256=', 'sha1='))).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    // timingSafeEqual throws on a length mismatch, which would itself leak.
    expect(verifyWebhookSignature(secret, body, good.slice(0, 20))).toBe(false);
  });
});

describe('isIngestablePath', () => {
  it('takes markdown and leaves everything else', () => {
    expect(isIngestablePath('docs/adr/adr-001.md')).toBe(true);
    expect(isIngestablePath('README.MD')).toBe(true);
    expect(isIngestablePath('docs/guide.mdx')).toBe(true);
    expect(isIngestablePath('src/index.ts')).toBe(false);
  });

  it('skips vendored trees', () => {
    // Somebody else's documentation buries the company's own writing under a
    // dependency's changelog.
    expect(isIngestablePath('node_modules/foo/README.md')).toBe(false);
    expect(isIngestablePath('vendor/lib/docs.md')).toBe(false);
    expect(isIngestablePath('dist/manual.md')).toBe(false);
  });
});

describe('planIngestion', () => {
  const files = [
    { path: 'a.md', sha: 'sha-a' },
    { path: 'b.md', sha: 'sha-b-new' },
    { path: 'src/x.ts', sha: 'sha-x' },
  ];

  it('fetches only what changed — git‘s blob sha IS the content hash', () => {
    const plan = planIngestion(files, new Map([['a.md', 'sha-a'], ['b.md', 'sha-b-old']]));
    expect(plan.fetch.map((f) => f.path)).toEqual(['b.md']);
    expect(plan.unchanged).toEqual(['a.md']);
  });

  it('reports a file that vanished instead of dropping it', () => {
    // It gets ANNOTATED, never trashed: deleting it would erase the record
    // that it once said something.
    const plan = planIngestion(files, new Map([['gone.md', 'sha-gone']]));
    expect(plan.gone).toEqual(['gone.md']);
  });

  it('refuses a file too large to be a document', () => {
    const plan = planIngestion([{ path: 'huge.md', sha: 's', size: 10_000_000 }], new Map());
    expect(plan.tooLarge).toEqual(['huge.md']);
    expect(plan.fetch).toEqual([]);
  });

  it('never looks at non-markdown, so a repo of code costs one listing', () => {
    const plan = planIngestion(files, new Map());
    expect(plan.fetch.map((f) => f.path)).toEqual(['a.md', 'b.md']);
  });
});
