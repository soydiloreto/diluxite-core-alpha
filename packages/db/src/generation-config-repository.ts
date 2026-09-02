import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * The generation provider an organisation configured — ADR-006, migration 0040.
 *
 * Same contract as the embedding configuration next door: `read()` returns the
 * sealed credential for the code that must build a provider, `redacted()`
 * returns everything else and is what an HTTP response is built from. A key
 * never leaves this repository in the clear.
 */

export type GenerationProviderName = 'openai-compatible' | 'ollama';

export interface GenerationConfigRow {
  orgId: string;
  provider: GenerationProviderName;
  model: string;
  endpoint: string;
  apiKeySealed: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export type RedactedGenerationConfig = Omit<GenerationConfigRow, 'apiKeySealed'> & {
  hasApiKey: boolean;
};

export interface GenerationConfigInput {
  orgId: string;
  provider: GenerationProviderName;
  model: string;
  endpoint: string;
  /**
   * `undefined` keeps the stored credential — an admin fixing a typo in the
   * endpoint cannot retype a key they are not allowed to read back, and a UI
   * sending `null` for "unchanged" would erase it silently the first time.
   */
  apiKeySealed?: string | null;
  updatedBy?: string | null;
}

export class DrizzleGenerationConfigRepository {
  constructor(private readonly db: Db) {}

  async read(orgId: string): Promise<GenerationConfigRow | null> {
    const rows = await this.db.execute<GenerationConfigRow & Record<string, unknown>>(sql`
      SELECT org_id AS "orgId", provider, model, endpoint,
             api_key_sealed AS "apiKeySealed",
             updated_at AS "updatedAt", updated_by AS "updatedBy"
      FROM generation_config WHERE org_id = ${orgId}`);
    return rows[0] ?? null;
  }

  async redacted(orgId: string): Promise<RedactedGenerationConfig | null> {
    const row = await this.read(orgId);
    if (!row) return null;
    const { apiKeySealed, ...rest } = row;
    return { ...rest, hasApiKey: apiKeySealed !== null && apiKeySealed !== undefined };
  }

  async write(input: GenerationConfigInput): Promise<GenerationConfigRow> {
    const keepKey = input.apiKeySealed === undefined;
    await this.db.execute(sql`
      INSERT INTO generation_config (org_id, provider, model, endpoint, api_key_sealed, updated_at, updated_by)
      VALUES (${input.orgId}, ${input.provider}, ${input.model}, ${input.endpoint},
              ${keepKey ? null : input.apiKeySealed}, now(), ${input.updatedBy ?? null})
      ON CONFLICT (org_id) DO UPDATE SET
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        endpoint = EXCLUDED.endpoint,
        api_key_sealed = ${keepKey ? sql`generation_config.api_key_sealed` : sql`EXCLUDED.api_key_sealed`},
        updated_at = now(),
        updated_by = EXCLUDED.updated_by`);
    return (await this.read(input.orgId))!;
  }

  /** Remove it. The queue keeps working: facts keep their templated questions. */
  async clear(orgId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM generation_config WHERE org_id = ${orgId}`);
  }
}
