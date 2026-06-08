import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzlePasskeysRepository } from './index';
import { ensureSingleUserBootstrap } from './spaces-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Tests del repositorio passkeys — dos almacenes con invariantes distintas:
 *
 *  1. Challenges single-use: `saveChallenge` deja una row por ceremonia y
 *     `takeChallenge` la CONSUME (DELETE … RETURNING). Tomarla dos veces
 *     devuelve null la segunda — base del anti-replay del flujo WebAuthn.
 *  2. Challenges tipados: una challenge de 'registration' no se puede consumir
 *     pidiendo 'authentication' (kind es parte del WHERE del DELETE).
 *  3. Credenciales por usuario: `register` persiste la credencial y
 *     `listForUser` la devuelve con sus campos.
 *  4. Aislamiento por usuario: `listForUser(otroUsuario)` no ve las credenciales
 *     ajenas.
 */

describe('DrizzlePasskeysRepository', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let db: ReturnType<typeof createDb>['db'];
  let repo: DrizzlePasskeysRepository;
  let userId: string;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    db = conn.db;
    await sql`TRUNCATE passkeys, webauthn_challenges, audit_events, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const b = await ensureSingleUserBootstrap(db);
    userId = b.userId;
    repo = new DrizzlePasskeysRepository(db);
  });

  afterEach(async () => {
    await sql.end();
  });

  describe('challenges (saveChallenge / takeChallenge)', () => {
    it('saveChallenge then takeChallenge returns it once; a second take returns null (single-use)', async () => {
      await repo.saveChallenge('chal-reg-1', 'registration', userId);

      const first = await repo.takeChallenge('chal-reg-1', 'registration');
      expect(first).not.toBeNull();
      expect(first!.userId).toBe(userId);

      // Single-use: the row was DELETEd on the first take.
      const second = await repo.takeChallenge('chal-reg-1', 'registration');
      expect(second).toBeNull();
    });

    it('authentication challenges carry a null userId (learned from credential on verify)', async () => {
      await repo.saveChallenge('chal-auth-1', 'authentication');
      const taken = await repo.takeChallenge('chal-auth-1', 'authentication');
      expect(taken).not.toBeNull();
      expect(taken!.userId).toBeNull();
    });

    it('takeChallenge with the wrong kind does NOT consume or return the challenge', async () => {
      await repo.saveChallenge('chal-reg-2', 'registration', userId);

      // Asking for 'authentication' must not match a 'registration' row.
      const wrong = await repo.takeChallenge('chal-reg-2', 'authentication');
      expect(wrong).toBeNull();

      // And it must NOT have been consumed: the correct kind still works.
      const right = await repo.takeChallenge('chal-reg-2', 'registration');
      expect(right).not.toBeNull();
      expect(right!.userId).toBe(userId);
    });

    it('an expired challenge is not returned', async () => {
      // ttlSeconds = -1 → expiresAt already in the past.
      await repo.saveChallenge('chal-expired', 'registration', userId, -1);
      const taken = await repo.takeChallenge('chal-expired', 'registration');
      expect(taken).toBeNull();
    });
  });

  describe('register / listForUser', () => {
    it('register persists a credential and listForUser returns it with the stored fields', async () => {
      const created = await repo.register({
        userId,
        credentialId: 'cred-abc',
        publicKey: 'pub-key-xyz',
        counter: 0,
        deviceType: 'platform',
        label: 'iPhone 17',
        transports: ['internal', 'hybrid'],
        backedUp: true,
      });

      expect(created.id).toBeTruthy();
      expect(created.credentialId).toBe('cred-abc');

      const list = await repo.listForUser(userId);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: created.id,
        userId,
        credentialId: 'cred-abc',
        publicKey: 'pub-key-xyz',
        counter: 0,
        deviceType: 'platform',
        label: 'iPhone 17',
        transports: ['internal', 'hybrid'],
        backedUp: true,
      });
      expect(list[0].createdAt).toBeInstanceOf(Date);
      expect(list[0].lastUsedAt).toBeNull();
    });

    it('applies column defaults (label, transports, backedUp) when omitted', async () => {
      await repo.register({
        userId,
        credentialId: 'cred-default',
        publicKey: 'pub-default',
        counter: 7,
      });
      const [row] = await repo.listForUser(userId);
      expect(row.label).toBe('passkey');
      expect(row.transports).toEqual([]);
      expect(row.backedUp).toBe(false);
      expect(row.deviceType).toBeNull();
      expect(row.counter).toBe(7);
    });

    it('listForUser is scoped to the user — another user sees an empty list', async () => {
      // Register a credential for the bootstrapped user.
      await repo.register({
        userId,
        credentialId: 'cred-owner',
        publicKey: 'pub-owner',
        counter: 0,
      });

      // Create a second user via a direct insert and confirm isolation.
      const [other] = await sql`
        INSERT INTO users (email, provider) VALUES ('other@diluxite', 'local')
        RETURNING id
      `;
      const otherId = other.id as string;

      expect(await repo.listForUser(otherId)).toHaveLength(0);
      // The owner still sees exactly their one credential.
      const ownerList = await repo.listForUser(userId);
      expect(ownerList).toHaveLength(1);
      expect(ownerList[0].credentialId).toBe('cred-owner');
    });
  });
});
