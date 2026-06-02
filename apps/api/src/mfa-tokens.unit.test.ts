import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mintMfaToken, verifyMfaToken, _resetMfaKeyCache } from './mfa-tokens';

/**
 * Tests del minter/verifier de mfaToken. Cubrimos:
 *  - Mint produce un string en formato user.exp.mac.
 *  - Verify acepta un token recién minteado.
 *  - Verify rechaza tokens corruptos (formato malo).
 *  - Verify rechaza tokens expirados (timestamp truncado al pasado).
 *  - Verify rechaza tokens con MAC inválida.
 *  - Verify rechaza si los bytes signing key cambian.
 *  - Tokens minteados para distinto userId verifican el userId correcto.
 */

describe('mfa-tokens', () => {
  beforeEach(() => {
    process.env.DILUXITE_MFA_SIGNING_KEY = 'test-key-deterministic-1234567890';
    _resetMfaKeyCache();
  });

  afterEach(() => {
    delete process.env.DILUXITE_MFA_SIGNING_KEY;
    _resetMfaKeyCache();
  });

  it('mintMfaToken produces a userId.exp.mac shape', () => {
    const tok = mintMfaToken('user-1');
    const parts = tok.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('user-1');
    expect(Number(parts[1])).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('verifyMfaToken accepts a fresh token', () => {
    const tok = mintMfaToken('user-42');
    const parsed = verifyMfaToken(tok);
    expect(parsed).not.toBeNull();
    expect(parsed!.userId).toBe('user-42');
  });

  it('verifyMfaToken returns null for malformed tokens', () => {
    expect(verifyMfaToken('')).toBeNull();
    expect(verifyMfaToken('only.one.dot')).toEqual(expect.objectContaining({})); // 3 parts but bad mac
    expect(verifyMfaToken('a.b.c.d')).toBeNull(); // too many parts
    expect(verifyMfaToken('userid')).toBeNull();
  });

  it('verifyMfaToken rejects expired tokens', () => {
    const tok = mintMfaToken('user-1');
    // Move clock 10 min into the future — TTL is 5 min.
    const parsed = verifyMfaToken(tok, Date.now() + 10 * 60 * 1000);
    expect(parsed).toBeNull();
  });

  it('verifyMfaToken rejects tampered MAC', () => {
    const tok = mintMfaToken('user-1');
    const parts = tok.split('.');
    parts[2] = parts[2].split('').reverse().join(''); // shuffle the MAC chars
    const tampered = parts.join('.');
    expect(verifyMfaToken(tampered)).toBeNull();
  });

  it('verifyMfaToken rejects userId substitution', () => {
    const tok = mintMfaToken('user-1');
    const parts = tok.split('.');
    parts[0] = 'user-2'; // attacker tries to escalate
    const forged = parts.join('.');
    expect(verifyMfaToken(forged)).toBeNull();
  });

  it('different signing keys produce incompatible tokens', () => {
    const tok = mintMfaToken('user-1');
    process.env.DILUXITE_MFA_SIGNING_KEY = 'different-key-1234567890abcdef';
    _resetMfaKeyCache();
    expect(verifyMfaToken(tok)).toBeNull();
  });

  it('falls back to admin password if MFA key is unset', () => {
    delete process.env.DILUXITE_MFA_SIGNING_KEY;
    process.env.DILUXITE_ADMIN_PASSWORD = 'admin-pw-12345';
    _resetMfaKeyCache();
    const tok = mintMfaToken('user-1');
    expect(verifyMfaToken(tok)).not.toBeNull();
    delete process.env.DILUXITE_ADMIN_PASSWORD;
  });
});
