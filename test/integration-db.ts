/**
 * One database per vitest project.
 *
 * The `db` and `api` projects each run their files one at a time, but vitest
 * runs the PROJECTS in parallel — and both pointed at `diluxite_test`. The db
 * suite truncates `users`, `notes`, `spaces` and `organizations` between
 * cases, so it was pulling rows out from under whatever the api suite was
 * doing at that moment.
 *
 * Measured: with the db suite looping in the background, 7 of the 9 tests in
 * `trusted-header.integration.test.ts` go red; alone they pass. That is the
 * "occasional flakes when the two projects share a database" line in the
 * roadmap, and it was never about clock resolution.
 *
 * Both databases derive from the same base URL, so `TEST_DATABASE_URL` still
 * points wherever the environment says — CI included. Only the database name
 * gains a suffix.
 */

export const BASE_TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

export type IntegrationProject = 'db' | 'api';

/**
 * The base URL with `_<project>` appended to the database name.
 *
 * Idempotent on purpose. This is read from two places that see a different
 * base: `vitest.config.mts` and each `globalSetup` see the raw
 * `TEST_DATABASE_URL`, while anything evaluated inside a worker sees the
 * suffixed one the config already injected. Appending blindly produced
 * `diluxite_test_api_api`, and the failure — `database does not exist` —
 * came out of an unrelated query, several frames away from the cause.
 */
export function databaseUrlFor(project: IntegrationProject): string {
  return BASE_TEST_DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, (_m, name: string, query) =>
    name.endsWith(`_${project}`) ? `/${name}${query ?? ''}` : `/${name}_${project}${query ?? ''}`,
  );
}

/** The database name inside that URL, for `CREATE DATABASE`. */
export function databaseNameFor(project: IntegrationProject): string {
  const match = /\/([^/?]+)(\?.*)?$/.exec(databaseUrlFor(project));
  if (!match) throw new Error(`cannot read a database name out of ${databaseUrlFor(project)}`);
  return match[1];
}

/** The same server, `postgres` database — where CREATE DATABASE has to run. */
export function adminUrl(): string {
  return (
    process.env.ADMIN_DATABASE_URL ??
    BASE_TEST_DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, (_m, _name, query) => `/postgres${query ?? ''}`)
  );
}
