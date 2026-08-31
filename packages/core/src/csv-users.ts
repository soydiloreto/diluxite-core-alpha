/**
 * Parser de CSV para bulk import de usuarios.
 *
 * No metemos una dep externa (papaparse, csv-parse) por dos razones:
 *   1. Nuestro caso es chico — 4 columnas, miles de filas. Un parser
 *      ad-hoc con tests adversariales cubre nuestro use case sin
 *      meter ~40 KB de bundle / supply chain.
 *   2. Las dependencias de CSV parsing suelen ser un nido de CVEs por
 *      manejo flojo de quote escaping. Mantenemos el parser acotado
 *      a lo que sabemos validar.
 *
 * Soporta:
 *   - Separadores `,` y `;` (auto-detecta por encabezado).
 *   - Quotes `"…"` con escape `""` dentro.
 *   - BOM UTF-8 al principio (Windows / Excel exportan así).
 *   - Línea-fin `\n` y `\r\n`.
 *   - Encabezados case-insensitive y tolerantes a sinónimos (e.g. `Email`,
 *     `e-mail`, `correo`; `first_name`, `firstName`, `nombre`; etc.).
 *
 * NO soporta:
 *   - Quotes anidadas con escape `\"` (estándar RFC pero raro).
 *   - Columnas con saltos de línea reales en mitad del valor (los
 *     rechazamos como "row truncated" más arriba — los CSV de admin
 *     no suelen tenerlos, y soportarlos infla mucho el parser).
 */

import { isEmailShaped } from './email-shape';

export interface CsvUserRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Optional. If absent or empty, the importer applies its default. */
  role: string | null;
  /** 1-based original line number — used in error reports for the UI. */
  line: number;
}

export interface CsvParseError {
  line: number;
  message: string;
  /** Raw row text for the UI to show "this is the bad line". */
  raw: string;
}

export interface CsvParseResult {
  rows: CsvUserRow[];
  errors: CsvParseError[];
  /** Which separator was detected — `,` (default) or `;`. */
  separator: ',' | ';';
}

/** Tolerant header → canonical mapping. Case-insensitive. */
const HEADER_ALIASES: Record<string, keyof CsvUserRow | 'skip'> = {
  email: 'email',
  'e-mail': 'email',
  correo: 'email',
  mail: 'email',
  first_name: 'firstName',
  firstname: 'firstName',
  nombre: 'firstName',
  given_name: 'firstName',
  last_name: 'lastName',
  lastname: 'lastName',
  apellido: 'lastName',
  surname: 'lastName',
  family_name: 'lastName',
  role: 'role',
  rol: 'role',
};

const VALID_ROLES = new Set(['admin', 'org_admin', 'member', 'editor', 'viewer']);

/** Strip a UTF-8 BOM if present. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Pick the most likely separator by counting on the header row, ignoring any
 * separators that live inside quoted fields (e.g. `"Last, Name";Email`). We
 * tentatively split with each candidate and keep the one yielding more columns.
 */
function detectSeparator(headerLine: string): ',' | ';' {
  const semicolons = splitLine(headerLine, ';').length;
  const commas = splitLine(headerLine, ',').length;
  return semicolons > commas ? ';' : ',';
}

/**
 * Splits a CSV line into fields respecting double-quoted values with
 * doubled-up quote escapes (`""` inside a quoted field).
 */
function splitLine(line: string, sep: ',' | ';'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseUsersCsv(input: string): CsvParseResult {
  const text = stripBom(input).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  // Skip leading blank lines: some exports prepend an empty line before the
  // header. `headerIdx` keeps reported line numbers aligned with the file.
  let headerIdx = 0;
  while (headerIdx < lines.length && lines[headerIdx].trim() === '') headerIdx++;
  if (headerIdx >= lines.length) {
    return { rows: [], errors: [{ line: 1, message: 'empty CSV', raw: '' }], separator: ',' };
  }
  const separator = detectSeparator(lines[headerIdx]);

  // Header → columnar map. Unknown headers are remembered as 'skip'.
  // `splitLine` already strips the surrounding quotes, so no extra de-quoting here.
  const rawHeaders = splitLine(lines[headerIdx], separator).map((h) => h.toLowerCase());
  const columnRole: Array<keyof CsvUserRow | 'skip'> = rawHeaders.map(
    (h) => HEADER_ALIASES[h] ?? 'skip',
  );

  if (!columnRole.includes('email')) {
    return {
      rows: [],
      errors: [
        {
          line: headerIdx + 1,
          message:
            'No "email" column found. Header row must include "email" (also accepted: e-mail, correo, mail).',
          raw: lines[headerIdx],
        },
      ],
      separator,
    };
  }

  const rows: CsvUserRow[] = [];
  const errors: CsvParseError[] = [];
  const seenEmails = new Set<string>();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue; // blank lines OK
    const fields = splitLine(raw, separator);

    const partial: Partial<CsvUserRow> = { firstName: null, lastName: null, role: null };
    for (let c = 0; c < columnRole.length; c++) {
      const role = columnRole[c];
      if (role === 'skip') continue;
      const v = fields[c]?.trim() ?? '';
      if (role === 'email') partial.email = v.toLowerCase();
      else if (role === 'firstName') partial.firstName = v || null;
      else if (role === 'lastName') partial.lastName = v || null;
      else if (role === 'role') partial.role = v || null;
    }
    partial.line = i + 1; // 1-based

    if (!partial.email) {
      errors.push({ line: i + 1, message: 'empty email', raw });
      continue;
    }
    if (!isEmailShaped(partial.email)) {
      errors.push({ line: i + 1, message: `invalid email: "${partial.email}"`, raw });
      continue;
    }
    if (partial.role && !VALID_ROLES.has(partial.role)) {
      errors.push({
        line: i + 1,
        message: `invalid role "${partial.role}" (allowed: ${[...VALID_ROLES].join(', ')})`,
        raw,
      });
      continue;
    }
    if (seenEmails.has(partial.email)) {
      errors.push({ line: i + 1, message: `duplicate email in CSV: ${partial.email}`, raw });
      continue;
    }
    seenEmails.add(partial.email);
    rows.push(partial as CsvUserRow);
  }

  return { rows, errors, separator };
}
