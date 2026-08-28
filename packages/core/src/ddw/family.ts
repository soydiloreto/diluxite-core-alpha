/**
 * DDW `## Repo family` section parsing.
 *
 * DDW (Dilux Development Workflow) repos declare their family membership in a
 * Field/Value table under a `## Repo family` heading inside `AGENTS.md`. The
 * connector maps one DDW family to one Diluxite workspace, named by the
 * `Family` field — derived, never configured, so the mapping cannot drift
 * (see docs/ddw-connector-design.md).
 */

export interface RepoFamilySection {
  family: string;
  /** owner/repo slug of the family's workspace repo, parentheticals stripped. */
  workspace: string;
  provides: string;
  consumedBy: string;
  consumes: string;
}

const FIELD_ROW = /^\|\s*([A-Za-z ]+?)\s*\|\s*(.+?)\s*\|\s*$/;

/**
 * Extract the `## Repo family` section fields from an AGENTS.md text, or null
 * when the repo declares no family. Prose around the table is the user's and
 * is ignored; keys are matched case-insensitively.
 */
export function parseRepoFamily(agentsMd: string): RepoFamilySection | null {
  const heading = /^##\s+Repo family\s*$/im.exec(agentsMd);
  if (!heading) return null;
  let body = agentsMd.slice(heading.index + heading[0].length);
  const next = /^##\s+/m.exec(body);
  if (next) body = body.slice(0, next.index);

  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const m = FIELD_ROW.exec(line.trim());
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (key === 'field' || key === '') continue;
    fields.set(key, m[2].trim());
  }
  const family = fields.get('family');
  if (!family) return null;
  return {
    family,
    workspace: (fields.get('workspace') ?? '').replace(/\s*\(.*\)\s*$/, '').trim(),
    provides: fields.get('provides') ?? '',
    consumedBy: fields.get('consumed by') ?? 'none',
    consumes: fields.get('consumes') ?? 'none',
  };
}

/** The Diluxite workspace a repo's notes land in. */
export function workspaceNameFor(section: RepoFamilySection | null, fallback = 'mis-repos'): string {
  return section?.family.trim() || fallback;
}
