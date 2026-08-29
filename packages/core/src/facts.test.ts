import { describe, it, expect } from 'vitest';
import { extractFacts, factsOf } from './facts';

/**
 * The asymmetry these tests are built around: a MISSING exact answer costs a
 * fallback to prose, which is where the system was anyway. A WRONG one is
 * served above the prose, labelled as fact, and believed. So most of what
 * follows checks that a doubtful table is skipped, not that a clear one is
 * indexed.
 */

describe('extractFacts', () => {
  it('reads a keyed table as "for KEY, COLUMN is VALUE"', () => {
    const md = `# Métricas

| Métrica | Valor | Dueño |
| --- | --- | --- |
| MRR | 42k | Ana |
| Altas | 120 | Beto |
`;
    const { tables } = extractFacts(md);
    expect(tables).toHaveLength(1);
    expect(tables[0].keyColumn).toBe('Métrica');
    expect(tables[0].facts).toEqual([
      { key: 'MRR', column: 'Valor', value: '42k', line: 5, keyColumn: 'Métrica' },
      { key: 'MRR', column: 'Dueño', value: 'Ana', line: 5, keyColumn: 'Métrica' },
      { key: 'Altas', column: 'Valor', value: '120', line: 6, keyColumn: 'Métrica' },
      { key: 'Altas', column: 'Dueño', value: 'Beto', line: 6, keyColumn: 'Métrica' },
    ]);
  });

  it('records the line of each row, so a fact can cite where it came from', () => {
    const md = ['prose', '', '| K | V |', '| --- | --- |', '| a | 1 |', '| b | 2 |'].join('\n');
    const [t] = extractFacts(md).tables;
    expect(t.headerLine).toBe(3);
    expect(t.facts.map((f) => f.line)).toEqual([5, 6]);
  });

  it('finds several tables in one note', () => {
    const md = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |

texto entre medio

| C | D |
| --- | --- |
| c1 | d1 |
| c2 | d2 |
`;
    expect(extractFacts(md).tables).toHaveLength(2);
  });

  describe('what it refuses to index, and why', () => {
    // A repeated key cannot name one row, so a lookup would return several
    // conflicting answers with the confidence of an exact hit. Matrices, logs
    // and groupings are all legitimate tables and none of them is a lookup.
    it('skips a table whose first column repeats', () => {
      const md = `| Equipo | Persona |
| --- | --- |
| Data | Ana |
| Data | Beto |
| UX | Caro |
`;
      const { tables, skipped } = extractFacts(md);
      expect(tables).toHaveLength(0);
      expect(skipped[0].reason).toBe('duplicate-keys');
    });

    it('skips a one-column table: there is nothing to look up', () => {
      const md = ['| Pendientes |', '| --- |', '| uno |', '| dos |'].join('\n');
      const { tables, skipped } = extractFacts(md);
      expect(tables).toHaveLength(0);
      expect(skipped[0].reason).toBe('single-column');
    });

    it('skips a table with a blank key: a nameless row cannot be found', () => {
      const md = `| Métrica | Valor |
| --- | --- |
| MRR | 42k |
|  | 120 |
`;
      const { tables, skipped } = extractFacts(md);
      expect(tables).toHaveLength(0);
      expect(skipped[0].reason).toBe('blank-keys');
    });

    // Two rows of "Pros | Cons" is a rhetorical device, not a dataset.
    it('skips a table with a single data row', () => {
      const md = ['| K | V |', '| --- | --- |', '| solo | 1 |'].join('\n');
      const { tables, skipped } = extractFacts(md);
      expect(tables).toHaveLength(0);
      expect(skipped[0].reason).toBe('too-few-rows');
    });

    it('ignores pipes in prose that are not a table', () => {
      const md = 'Usá `a | b` para separar, o mirá la opción --foo | bar.';
      expect(extractFacts(md).tables).toHaveLength(0);
    });

    it('needs the GFM separator row, not just pipes', () => {
      const md = ['| A | B |', '| a | 1 |', '| b | 2 |'].join('\n');
      expect(extractFacts(md).tables).toHaveLength(0);
    });
  });

  describe('cells', () => {
    it('drops empty cells: an absence is not a fact that the value is blank', () => {
      const md = `| Métrica | Valor | Nota |
| --- | --- | --- |
| MRR | 42k |  |
| Altas | 120 | ok |
`;
      const facts = factsOf(md);
      expect(facts.map((f) => `${f.key}.${f.column}`)).toEqual([
        'MRR.Valor',
        'Altas.Valor',
        'Altas.Nota',
      ]);
    });

    it('tolerates ragged rows rather than throwing', () => {
      const md = `| A | B | C |
| --- | --- | --- |
| a | 1 |
| b | 2 | 3 |
`;
      const facts = factsOf(md);
      expect(facts.find((f) => f.key === 'a' && f.column === 'C')).toBeUndefined();
      expect(facts.find((f) => f.key === 'b' && f.column === 'C')?.value).toBe('3');
    });

    it('handles alignment markers in the separator', () => {
      const md = ['| A | B |', '|:--- | ---:|', '| a | 1 |', '| b | 2 |'].join('\n');
      expect(extractFacts(md).tables).toHaveLength(1);
    });

    it('treats keys case-insensitively when checking uniqueness', () => {
      // "MRR" and "mrr" would collide on any sane lookup, so the table is not
      // a reliable index even though the strings differ.
      const md = ['| K | V |', '| --- | --- |', '| MRR | 1 |', '| mrr | 2 |'].join('\n');
      expect(extractFacts(md).skipped[0].reason).toBe('duplicate-keys');
    });
  });

  it('says why it skipped, instead of skipping silently', () => {
    // A silent skip is indistinguishable from a parser bug, and the difference
    // is what someone needs when their table is not answering.
    const md = `| Equipo | Persona |
| --- | --- |
| Data | Ana |
| Data | Beto |
`;
    const { skipped } = extractFacts(md);
    expect(skipped).toEqual([{ headerLine: 1, reason: 'duplicate-keys' }]);
  });

  it('returns nothing for a note with no tables at all', () => {
    expect(factsOf('# Solo prosa\n\nNada tabulado por acá.')).toEqual([]);
    expect(factsOf('')).toEqual([]);
  });

  /**
   * CodeQL flagged the first draft of this parser for polynomial ReDoS, and it
   * was right — the separator pattern had `\s` and `|` inside character
   * classes sitting next to quantifiers matching the same characters. Note
   * content is attacker-controlled in any deployment with more than one
   * member, and Fastify's body limit is a megabyte.
   *
   * Same lesson as the email check earlier today, on code written hours after
   * writing that one down. Hence: no regex in the hot path, and a test that
   * measures instead of trusting.
   */
  it('parses adversarial input in linear time', () => {
    const cases = [
      '\t'.repeat(100_000),
      '\t|'.repeat(50_000),
      `| ${' '.repeat(100_000)} |`,
      '|'.repeat(100_000),
      `| A | B |\n| --- | --- |\n| a | ${'x'.repeat(200_000)} |`,
    ];
    for (const md of cases) {
      const started = performance.now();
      extractFacts(md);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
