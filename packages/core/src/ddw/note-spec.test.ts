import { describe, expect, it } from 'vitest';

import { parseTags } from '../tags.js';
import { uniqueTargets } from '../wikilinks.js';
import { parseRepoFamily, workspaceNameFor } from './family.js';
import {
  archiveAnnotation,
  buildDdwNoteSpec,
  buildFamilyHub,
  buildRepoHub,
  ddwNoteTitle,
  isArchiveAnnotated,
  parseSourceFooter,
} from './note-spec.js';
import { classifyDdwPath, ticketIdOf } from './sources.js';

const AGENTS = `# ddw-demo-back

## Stack

| Campo | Valor |
|---|---|
| Lenguaje | Python |

## Repo family

| Field | Value |
|---|---|
| Family | tienda-demo |
| Workspace | soydiloreto/ddw-demo-workspace (este repo) |
| Provides | REST API /api/v1 |
| Consumed by | ddw-demo-bff |
| Consumes | none |

## Conventions
`;

describe('parseRepoFamily', () => {
  it('reads the section and strips workspace parentheticals', () => {
    const f = parseRepoFamily(AGENTS);
    expect(f).not.toBeNull();
    expect(f?.family).toBe('tienda-demo');
    expect(f?.workspace).toBe('soydiloreto/ddw-demo-workspace');
    expect(f?.consumedBy).toBe('ddw-demo-bff');
  });

  it('returns null without the section, and the workspace name falls back', () => {
    expect(parseRepoFamily('# repo\n\n## Stack\n')).toBeNull();
    expect(workspaceNameFor(null)).toBe('mis-repos');
    expect(workspaceNameFor(parseRepoFamily(AGENTS))).toBe('tienda-demo');
  });
});

describe('classifyDdwPath / ticketIdOf', () => {
  it('maps every governed path to its kind and skips validation receipts', () => {
    expect(classifyDdwPath('docs/ddw/prd/prd-FEAT-001.md')).toBe('prd');
    expect(classifyDdwPath('docs/ddw/prd/prd-FEAT-001.validation.md')).toBeNull();
    expect(classifyDdwPath('docs/ddw/specs/decisions-FEAT-001.md')).toBe('decision');
    expect(classifyDdwPath('docs/ddw/specs/spec-FEAT-001.md')).toBe('spec');
    expect(classifyDdwPath('docs/adr/adr-001-cookies.md')).toBe('adr');
    expect(classifyDdwPath('docs/ddw/security/threat-FEAT-001.md')).toBe('threat');
    expect(classifyDdwPath('docs/ddw/security/sast-FEAT-001.md')).toBe('sast');
    expect(classifyDdwPath('docs/ddw/reports/tests-FEAT-001.md')).toBe('tests');
    expect(classifyDdwPath('docs/ddw/reports/verify-FEAT-001.md')).toBe('verify');
    expect(classifyDdwPath('docs/ddw/family-catalog.md')).toBe('catalogo');
    expect(classifyDdwPath('src/app.py')).toBeNull();
    expect(classifyDdwPath('README.md')).toBeNull();
  });

  it('recognizes a multirepo index by its marker', () => {
    const idx = '| Ticket | T-1 |\n| Status | Multirepo split |\n';
    expect(classifyDdwPath('docs/ddw/prd/prd-T-1.md', idx)).toBe('indice');
  });

  it('extracts the ticket id, split suffixes included', () => {
    expect(ticketIdOf('docs/ddw/prd/prd-FEAT-001.md')).toBe('FEAT-001');
    expect(ticketIdOf('docs/ddw/prd/prd-FEAT-001a.md')).toBe('FEAT-001a');
    expect(ticketIdOf('docs/ddw/family-catalog.md')).toBeNull();
  });
});

describe('buildDdwNoteSpec', () => {
  const doc = {
    repo: 'ddw-demo-back',
    relPath: 'docs/adr/adr-001-cookies.md',
    content: '# ADR 1\n\nUse signed cookies.\n\n```bash\necho "#not-a-tag"\n```\n',
    blobSha: 'abc123',
    family: 'tienda-demo',
  };

  it('renders a body whose TEXT carries the tags the indexer derives', () => {
    const spec = buildDdwNoteSpec(doc, new Date('2026-08-26T00:00:00Z'));
    expect(spec).not.toBeNull();
    const tags = parseTags(`${spec!.title}\n\n${spec!.contentMd}`);
    expect(tags).toEqual(
      expect.arrayContaining(['ddw', 'repo/ddw-demo-back', 'tipo/adr', 'familia/tienda-demo']),
    );
    // the fenced block's fake tag must NOT leak into the derived tags
    expect(tags).not.toContain('not-a-tag');
  });

  it('wikilinks to the repo hub, and the footer round-trips', () => {
    const spec = buildDdwNoteSpec(doc)!;
    expect(uniqueTargets(spec.contentMd)).toContain('DDW · ddw-demo-back');
    const footer = parseSourceFooter(spec.contentMd);
    expect(footer).toEqual(
      expect.objectContaining({ repo: 'ddw-demo-back', path: 'docs/adr/adr-001-cookies.md', blob: 'abc123' }),
    );
  });

  it('returns null for a non-DDW file, and titles are deterministic', () => {
    expect(buildDdwNoteSpec({ ...doc, relPath: 'src/main.py' })).toBeNull();
    expect(ddwNoteTitle('r', 'docs/adr/a.md')).toBe('DDW · r · docs/adr/a.md');
  });
});

describe('hubs and archive annotation', () => {
  it('the repo hub links its docs and its family; the family hub links its repos', () => {
    const hub = buildRepoHub('ddw-demo-back', 'tienda-demo', ['DDW · ddw-demo-back · docs/adr/a.md']);
    expect(uniqueTargets(hub.contentMd)).toContain('DDW · familia tienda-demo');
    expect(uniqueTargets(hub.contentMd)).toContain('DDW · ddw-demo-back · docs/adr/a.md');
    const fam = buildFamilyHub('tienda-demo', ['ddw-demo-back', 'ddw-demo-bff']);
    expect(uniqueTargets(fam.contentMd)).toContain('DDW · ddw-demo-back');
  });

  it('archiving is an annotation, detectable and idempotent by inspection', () => {
    const ann = archiveAnnotation('abc123', new Date('2026-08-26T00:00:00Z'));
    expect(ann).toContain('abc123');
    expect(isArchiveAnnotated(`body${ann}`)).toBe(true);
    expect(isArchiveAnnotated('body')).toBe(false);
  });
});
