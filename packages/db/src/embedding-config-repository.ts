import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * The embedding provider the operator chose — ADR-003, migration 0029.
 *
 * One row for the whole installation. Distinct from `embedding_models`, which
 * catalogues the vector spaces that exist: this says what SHOULD be running,
 * and survives the restart that used to be the only way to change it.
 *
 * The API key never leaves this repository in the clear on the way out to a
 * client. `read()` returns the sealed blob for the code that must build a
 * provider; `redacted()` returns everything else, and is what an HTTP response
 * is built from.
 */

export type EmbeddingProviderName = 'local' | 'ollama' | 'azure' | 'bedrock';

export interface EmbeddingConfigRow {
  provider: EmbeddingProviderName;
  model: string | null;
  dimensions: number;
  endpoint: string | null;
  apiKeySealed: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Everything except the credential, plus whether one is stored at all. */
export type RedactedEmbeddingConfig = Omit<EmbeddingConfigRow, 'apiKeySealed'> & {
  hasApiKey: boolean;
};

export interface EmbeddingConfigInput {
  provider: EmbeddingProviderName;
  model: string | null;
  dimensions: number;
  endpoint: string | null;
  /**
   * The sealed credential, or:
   *   - `undefined` → keep whatever is stored (an edit that does not retype it)
   *   - `null`      → remove it (a switch to a provider that needs none)
   */
  apiKeySealed?: string | null;
  updatedBy?: string | null;
}

export class DrizzleEmbeddingConfigRepository {
  constructor(private readonly db: Db) {}

  async read(): Promise<EmbeddingConfigRow | null> {
    const rows = await this.db.execute<EmbeddingConfigRow & Record<string, unknown>>(sql`
      SELECT provider, model, dimensions, endpoint,
             api_key_sealed AS "apiKeySealed",
             updated_at AS "updatedAt", updated_by AS "updatedBy"
      FROM embedding_config WHERE id = true`);
    return rows[0] ?? null;
  }

  /** Safe to hand to a client: the credential is reduced to a boolean. */
  async redacted(): Promise<RedactedEmbeddingConfig | null> {
    const row = await this.read();
    if (!row) return null;
    const { apiKeySealed, ...rest } = row;
    return { ...rest, hasApiKey: apiKeySealed !== null && apiKeySealed !== undefined };
  }

  /**
   * Write the configuration, keeping the stored credential when the caller
   * did not supply one.
   *
   * That distinction is the reason `apiKeySealed` is optional rather than
   * nullable-only: an admin editing the endpoint should not have to retype a
   * key they cannot read back, and a UI that sends `null` for "unchanged"
   * would erase it silently the first time someone fixed a typo.
   */
  async write(input: EmbeddingConfigInput): Promise<EmbeddingConfigRow> {
    const keepKey = input.apiKeySealed === undefined;
    await this.db.execute(sql`
      INSERT INTO embedding_config (id, provider, model, dimensions, endpoint, api_key_sealed, updated_at, updated_by)
      VALUES (true, ${input.provider}, ${input.model}, ${input.dimensions}, ${input.endpoint},
              ${keepKey ? null : input.apiKeySealed}, now(), ${input.updatedBy ?? null})
      ON CONFLICT (id) DO UPDATE SET
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        dimensions = EXCLUDED.dimensions,
        endpoint = EXCLUDED.endpoint,
        api_key_sealed = ${keepKey ? sql`embedding_config.api_key_sealed` : sql`EXCLUDED.api_key_sealed`},
        updated_at = now(),
        updated_by = EXCLUDED.updated_by`);
    return (await this.read())!;
  }

  /** Remove the configuration entirely, falling back to the environment. */
  async clear(): Promise<void> {
    await this.db.execute(sql`DELETE FROM embedding_config WHERE id = true`);
  }
}
