/**
 * Which files of a DDW repo become Diluxite notes, and what kind each one is.
 *
 * DDW commits every governed artifact under known paths; the connector reads
 * exactly those and nothing else. The kind drives the `#tipo/…` tag, so it is
 * a closed vocabulary here rather than a guess per file.
 */

export type DdwDocKind =
  | 'prd'
  | 'indice'
  | 'spec'
  | 'decision'
  | 'adr'
  | 'threat'
  | 'sast'
  | 'tests'
  | 'verify'
  | 'catalogo';

/** Classify a repo-relative path, or null when it is not a DDW artifact. */
export function classifyDdwPath(relPath: string, content?: string): DdwDocKind | null {
  const p = relPath.replace(/\\/g, '/');
  if (!p.endsWith('.md')) return null;
  if (p === 'docs/ddw/family-catalog.md') return 'catalogo';
  if (p.startsWith('docs/adr/')) return 'adr';
  if (p.startsWith('docs/ddw/prd/')) {
    if (p.includes('.validation.')) return null;
    // A multirepo/split index is still a PRD file; the marker decides.
    if (content && /^\|\s*Status\s*\|\s*(Multirepo|Split)/im.test(content)) return 'indice';
    return 'prd';
  }
  if (p.startsWith('docs/ddw/specs/')) {
    if (p.includes('.validation.')) return null;
    if (/\/decisions-[^/]+\.md$/.test(p)) return 'decision';
    return 'spec';
  }
  if (p.startsWith('docs/ddw/security/')) {
    if (p.includes('.validation.')) return null;
    if (/\/threat-[^/]+\.md$/.test(p)) return 'threat';
    if (/\/sast-[^/]+\.md$/.test(p)) return 'sast';
    return null;
  }
  if (p.startsWith('docs/ddw/reports/')) {
    if (p.includes('.validation.')) return null;
    if (/\/tests-[^/]+\.md$/.test(p)) return 'tests';
    if (/\/verify-[^/]+\.md$/.test(p)) return 'verify';
    return null;
  }
  return null;
}

/** The DDW ticket id a filename carries (`prd-FEAT-001.md` → `FEAT-001`), or null. */
export function ticketIdOf(relPath: string): string | null {
  const base = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /(?:^|-)([A-Z][A-Z0-9]*-\d+[a-z]?)\.md$/.exec(base);
  return m ? m[1] : null;
}
