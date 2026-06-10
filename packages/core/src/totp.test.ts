import { describe, it, expect } from 'vitest';
import {
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  buildOtpauthUrl,
  generateBackupCodes,
  hashBackupCode,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from './totp';

/**
 * Tests del helper TOTP. Cubrimos:
 *  - Genera secret base32 de longitud razonable (32 chars = 160 bits).
 *  - El code generado tiene 6 dígitos numéricos.
 *  - Verify acepta el code generado en la misma ventana.
 *  - Verify rechaza un code random.
 *  - Verify acepta ±1 step (clock drift).
 *  - Verify rechaza ±2 step (fuera de la tolerancia).
 *  - Verify normaliza padding ('012345' OK, '12345' OK con pad).
 *  - Verify rechaza no-numeric.
 *  - buildOtpauthUrl produce un URI válido.
 *  - generateBackupCodes devuelve N códigos únicos y sus hashes.
 *  - hashBackupCode es estable, case-insensitive y trim-tolerant.
 *  - RFC 6238 known-answer test vectors (HMAC-SHA1, 8-digit truncated to 6).
 */

describe('generateTotpSecret', () => {
  it('returns a base32 string of at least 32 chars', () => {
    const s = generateTotpSecret();
    expect(s.length).toBeGreaterThanOrEqual(32);
    expect(s).toMatch(/^[A-Z2-7]+$/);
  });

  it('two calls produce different secrets', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe('generateTotpCode', () => {
  it('produces a 6-digit numeric string', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(code.length).toBe(TOTP_DIGITS);
  });

  it('is deterministic for a fixed timestamp + secret', () => {
    const secret = generateTotpSecret();
    expect(generateTotpCode(secret, 1700000000000)).toBe(generateTotpCode(secret, 1700000000000));
  });

  it('different timestamps in the same period produce the same code', () => {
    const secret = generateTotpSecret();
    // Pin to the start of a period to avoid crossing the window boundary.
    const periodMs = TOTP_PERIOD_SECONDS * 1000;
    const t = Math.floor(1700000000000 / periodMs) * periodMs;
    const sameWindow = t + (TOTP_PERIOD_SECONDS - 1) * 1000;
    expect(generateTotpCode(secret, t)).toBe(generateTotpCode(secret, sameWindow));
  });

  it('different periods produce different codes (overwhelming probability)', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const nextWindow = t + TOTP_PERIOD_SECONDS * 1000;
    expect(generateTotpCode(secret, t)).not.toBe(generateTotpCode(secret, nextWindow));
  });
});

describe('verifyTotpCode', () => {
  it('accepts a code from the SAME time-step', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const code = generateTotpCode(secret, t);
    expect(verifyTotpCode(secret, code, t)).toBe(true);
  });

  it('accepts a code from -1 time-step (clock drift backwards)', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const prev = generateTotpCode(secret, t - TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotpCode(secret, prev, t)).toBe(true);
  });

  it('accepts a code from +1 time-step (clock drift forwards)', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const next = generateTotpCode(secret, t + TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotpCode(secret, next, t)).toBe(true);
  });

  it('rejects a code from -2 time-step (outside tolerance window)', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const old = generateTotpCode(secret, t - 2 * TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotpCode(secret, old, t)).toBe(false);
  });

  it('rejects a code from +2 time-step', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const future = generateTotpCode(secret, t + 2 * TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotpCode(secret, future, t)).toBe(false);
  });

  it('rejects a random 6-digit code (overwhelming probability)', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, '000000', 1700000000000)).toBe(
      generateTotpCode(secret, 1700000000000) === '000000',
    );
    // Very likely false unless the secret coincidentally maps to 000000.
  });

  it('rejects a code against a DIFFERENT secret', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    const t = 1700000000000;
    const codeA = generateTotpCode(a, t);
    expect(verifyTotpCode(b, codeA, t)).toBe(false);
  });

  it('rejects non-numeric input', () => {
    const s = generateTotpSecret();
    expect(verifyTotpCode(s, 'abcdef')).toBe(false);
    expect(verifyTotpCode(s, '12345A')).toBe(false);
    expect(verifyTotpCode(s, '')).toBe(false);
  });

  it('trims whitespace and normalises padding', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000;
    const code = generateTotpCode(secret, t);
    expect(verifyTotpCode(secret, `  ${code}  `, t)).toBe(true);
    // Strip a leading zero: should still verify after pad-back.
    if (code.startsWith('0')) {
      expect(verifyTotpCode(secret, code.replace(/^0+/, ''), t)).toBe(true);
    }
  });

  it('rejects inputs longer than the digit length', () => {
    const s = generateTotpSecret();
    expect(verifyTotpCode(s, '1234567')).toBe(false);
  });
});

describe('buildOtpauthUrl', () => {
  it('produces a valid otpauth:// URI with issuer + account', () => {
    const url = buildOtpauthUrl({
      issuer: 'Diluxite',
      accountName: 'pablo@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(decodeURIComponent(url)).toContain('Diluxite:pablo@example.com');
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=Diluxite');
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });

  it('encodes spaces in the issuer as %20, not + (authenticator compat)', () => {
    const url = buildOtpauthUrl({
      issuer: 'Mi Empresa',
      accountName: 'pablo@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(url).toContain('issuer=Mi%20Empresa');
    expect(url).not.toContain('Mi+Empresa');
  });

  it('URL-encodes account names with colons or spaces', () => {
    const url = buildOtpauthUrl({
      issuer: 'Diluxite',
      accountName: 'name with spaces:tricky',
      secret: 'ABC',
    });
    // The label part (before `?`) must be encoded.
    const label = url.split('?')[0];
    expect(label).not.toContain(' ');
  });
});

describe('generateBackupCodes', () => {
  it('returns 10 unique codes by default + their hashes', () => {
    const { plaintext, hashes } = generateBackupCodes();
    expect(plaintext).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    expect(new Set(plaintext).size).toBe(10);
    expect(plaintext.every((c) => /^[0-9a-f]{8}$/.test(c))).toBe(true);
  });

  it('respects the N parameter', () => {
    expect(generateBackupCodes(3).plaintext).toHaveLength(3);
    expect(generateBackupCodes(20).hashes).toHaveLength(20);
  });

  it('hash of each plaintext matches hashBackupCode(plaintext)', () => {
    const { plaintext, hashes } = generateBackupCodes(5);
    for (let i = 0; i < 5; i++) {
      expect(hashes[i]).toBe(hashBackupCode(plaintext[i]));
    }
  });
});

describe('hashBackupCode', () => {
  it('is deterministic', () => {
    expect(hashBackupCode('abcd1234')).toBe(hashBackupCode('abcd1234'));
  });

  it('is case-insensitive', () => {
    expect(hashBackupCode('ABCD1234')).toBe(hashBackupCode('abcd1234'));
  });

  it('trims whitespace', () => {
    expect(hashBackupCode('  abcd1234  ')).toBe(hashBackupCode('abcd1234'));
  });

  it('different codes produce different hashes', () => {
    expect(hashBackupCode('abcd1234')).not.toBe(hashBackupCode('abcd1235'));
  });
});

describe('RFC 6238 known-answer vectors', () => {
  // The RFC vectors are for HMAC-SHA1, 8-digit; the algorithm matches but our
  // truncation is to 6. We re-derive the expected 6-digit value by taking the
  // 8-digit RFC value and modding by 10^6.
  // RFC 6238 Appendix B reference table (8-digit values):
  //   T = 59          → 94287082
  //   T = 1111111109  → 07081804
  //   T = 1111111111  → 14050471
  // Secret = "12345678901234567890" in ASCII → base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const cases: Array<{ t: number; expected8: string }> = [
    { t: 59, expected8: '94287082' },
    { t: 1111111109, expected8: '07081804' },
    { t: 1111111111, expected8: '14050471' },
  ];
  for (const c of cases) {
    it(`matches RFC vector at T=${c.t}`, () => {
      const expected6 = (Number(c.expected8) % 1000000).toString().padStart(6, '0');
      const code = generateTotpCode(secret, c.t * 1000);
      expect(code).toBe(expected6);
    });
  }
});
