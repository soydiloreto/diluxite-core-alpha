/**
 * Tables inside notes, read as rows — ADR-001 step 2 (`query_facts`).
 *
 * Markdown stays the source of truth. This derives facts from it at save
 * time, the same way tags and wikilinks are already derived: nobody authors a
 * fact, so there is exactly one place to correct a wrong one — the note.
 *
 * THE GOVERNING ASYMMETRY. A missing exact answer costs a fallback to prose,
 * which is where the system was anyway. A WRONG exact answer is delivered
 * above the prose, labelled as a fact, and believed. So every judgement call
 * below resolves toward not indexing: a table earns fact status, it is not
 * given it by default.
 */

/** One cell, addressable as "for KEY, the COLUMN is VALUE". */
export interface Fact {
  /** The row's identity — the value in the key column. */
  key: string;
  /** The column header this value sits under. */
  column: string;
  value: string;
  /** 1-indexed line in the note where the row lives, for provenance. */
  line: number;
  /** The key column's own header, so a reader knows what `key` names. */
  keyColumn: string;
}

export interface FactTable {
  keyColumn: string;
  columns: string[];
  facts: Fact[];
  /** 1-indexed line of the header row. */
  headerLine: number;
}

/** Why a table was not turned into facts. Surfaced so the skip is inspectable. */
export type TableSkipReason =
  | 'not-a-table'
  | 'single-column'
  | 'too-few-rows'
  | 'duplicate-keys'
  | 'blank-keys';

export interface SkippedTable {
  headerLine: number;
  reason: TableSkipReason;
}

export interface FactExtraction {
  tables: FactTable[];
  skipped: SkippedTable[];
}

/**
 * A table needs at least this many data rows to be a dataset rather than an
 * aside. Two rows of "Pros | Cons" is a rhetorical device, not a lookup.
 */
const MIN_DATA_ROWS = 2;

const splitRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

/** GFM's separator row: `| --- | :---: |`. It is what makes a table a table. */
const isSeparator = (line: string): boolean =>
  /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);

const isRow = (line: string): boolean => line.trim().startsWith('|');

/**
 * Pick the column whose values identify the rows.
 *
 * **The first column, if its values are unique.** Not a heuristic over header
 * names — "Name", "Metric", "Clave" and their translations are an endless
 * list, and guessing wrong silently re-keys the whole table.
 *
 * Uniqueness is the test because it is the property being relied on: a lookup
 * only means anything if a key names one row. A table whose first column
 * repeats is a matrix, a log, or a grouping — all legitimate, none of them a
 * key-value lookup — and it is skipped rather than indexed under a key that
 * would return several conflicting answers.
 */
function keyColumnOf(
  headers: string[],
  rows: string[][],
): { index: number; reason?: TableSkipReason } {
  if (headers.length < 2) return { index: -1, reason: 'single-column' };
  const values = rows.map((r) => (r[0] ?? '').trim());
  if (values.some((v) => v.length === 0)) return { index: -1, reason: 'blank-keys' };
  if (new Set(values.map((v) => v.toLowerCase())).size !== values.length) {
    return { index: -1, reason: 'duplicate-keys' };
  }
  return { index: 0 };
}

/**
 * Extract every indexable table from a note.
 *
 * Returns the tables that qualify AND the ones that did not, with the reason.
 * A silent skip is indistinguishable from a parser bug, and the difference
 * matters when someone asks why their table is not answering.
 */
export function extractFacts(markdown: string): FactExtraction {
  const lines = markdown.split('\n');
  const tables: FactTable[] = [];
  const skipped: SkippedTable[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!isRow(lines[i]) || i + 1 >= lines.length || !isSeparator(lines[i + 1])) {
      i++;
      continue;
    }
    const headerLine = i + 1; // 1-indexed
    const headers = splitRow(lines[i]);
    const rows: { cells: string[]; line: number }[] = [];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j]) && !isSeparator(lines[j])) {
      rows.push({ cells: splitRow(lines[j]), line: j + 1 });
      j++;
    }

    if (rows.length < MIN_DATA_ROWS) {
      skipped.push({ headerLine, reason: 'too-few-rows' });
    } else {
      const { index, reason } = keyColumnOf(
        headers,
        rows.map((r) => r.cells),
      );
      if (index < 0) {
        skipped.push({ headerLine, reason: reason ?? 'not-a-table' });
      } else {
        const keyColumn = headers[index];
        const facts: Fact[] = [];
        for (const row of rows) {
          const key = (row.cells[index] ?? '').trim();
          for (let c = 0; c < headers.length; c++) {
            if (c === index) continue;
            const value = (row.cells[c] ?? '').trim();
            // An empty cell is an absence, not a fact that the value is "".
            if (!value) continue;
            facts.push({ key, column: headers[c], value, line: row.line, keyColumn });
          }
        }
        if (facts.length > 0) {
          tables.push({ keyColumn, columns: headers, facts, headerLine });
        } else {
          skipped.push({ headerLine, reason: 'too-few-rows' });
        }
      }
    }
    i = j;
  }

  return { tables, skipped };
}

/** Every fact in a note, flattened — what the indexer stores. */
export function factsOf(markdown: string): Fact[] {
  return extractFacts(markdown).tables.flatMap((t) => t.facts);
}
