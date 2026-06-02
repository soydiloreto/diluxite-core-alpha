import { describe, it, expect } from 'vitest';
import { parseUsersCsv } from './csv-users';

/**
 * Unit tests súper-furiosos del parser CSV de usuarios.
 *
 * Cubrimos:
 *   - Happy paths (comma + semicolon, headers en minúscula/mixto/synonyms).
 *   - Quotes (simple, doubled-up escape, embedded separator).
 *   - BOM UTF-8 (Excel siempre exporta así).
 *   - CRLF vs LF.
 *   - Líneas en blanco salteables.
 *   - Errores per-line (email malformado, email vacío, role inválido,
 *     duplicados intra-CSV).
 *   - Headers desconocidos (skip OK).
 *   - Header faltante de email (fatal).
 *   - Linenums correctos en el reporte de errores.
 */

describe('parseUsersCsv — happy paths', () => {
  it('comma-separated, all 4 columns, lowercases the email', () => {
    const csv = `email,first_name,last_name,role
Ana@Empresa.com,Ana,Pérez,member
bob@x.com,Bob,Smith,admin`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.separator).toBe(',');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      email: 'ana@empresa.com',
      firstName: 'Ana',
      lastName: 'Pérez',
      role: 'member',
      line: 2,
    });
    expect(r.rows[1].role).toBe('admin');
  });

  it('semicolon-separated (Excel-style export from es-ES locales)', () => {
    const csv = `email;first_name;last_name;role
ana@empresa.com;Ana;Pérez;member`;
    const r = parseUsersCsv(csv);
    expect(r.separator).toBe(';');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].firstName).toBe('Ana');
  });

  it('header synonyms: e-mail, nombre, apellido, rol', () => {
    const csv = `e-mail,nombre,apellido,rol
ana@x.com,Ana,Pérez,member`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      email: 'ana@x.com',
      firstName: 'Ana',
      lastName: 'Pérez',
      role: 'member',
    });
  });

  it('mixed-case headers (Email, First_Name, …)', () => {
    const csv = `Email,FirstName,LastName
ana@x.com,Ana,Pérez`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].firstName).toBe('Ana');
  });

  it('only email column is required — names + role optional', () => {
    const csv = `email
ana@x.com
bob@x.com`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].firstName).toBeNull();
    expect(r.rows[0].lastName).toBeNull();
    expect(r.rows[0].role).toBeNull();
  });

  it('quotes are honored — value can include the separator inside', () => {
    const csv = `email,first_name,last_name
ana@x.com,"Ana, María","Pérez Juarez"`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].firstName).toBe('Ana, María');
    expect(r.rows[0].lastName).toBe('Pérez Juarez');
  });

  it('doubled-up quote escape ("") yields a literal quote', () => {
    const csv = `email,first_name
ana@x.com,"She said ""hi"""`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].firstName).toBe('She said "hi"');
  });

  it('strips UTF-8 BOM if present (Excel exports)', () => {
    const csv = `﻿email,first_name
ana@x.com,Ana`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
  });

  it('CRLF line endings (Windows files)', () => {
    const csv = `email,first_name\r\nana@x.com,Ana\r\nbob@x.com,Bob`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });

  it('blank lines between rows are skipped (not errors)', () => {
    const csv = `email,first_name
ana@x.com,Ana

bob@x.com,Bob
`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });

  it('unknown columns are tolerated (skipped silently)', () => {
    // Real exports often have extra columns (department, hire_date, …).
    // We grab what we know and ignore the rest.
    const csv = `email,first_name,department,hire_date,last_name
ana@x.com,Ana,Engineering,2024-01-15,Pérez`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      email: 'ana@x.com',
      firstName: 'Ana',
      lastName: 'Pérez',
    });
  });
});

describe('parseUsersCsv — error reporting', () => {
  it('missing "email" header → single fatal error on line 1', () => {
    const csv = `firstname,lastname
Ana,Pérez`;
    const r = parseUsersCsv(csv);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(1);
    expect(r.errors[0].message).toMatch(/no "email" column/i);
  });

  it('empty CSV → fatal error', () => {
    const r = parseUsersCsv('');
    expect(r.rows).toEqual([]);
    expect(r.errors[0].message).toMatch(/empty/i);
  });

  it('malformed email is per-line error, valid rows still pass', () => {
    const csv = `email,first_name
ok@x.com,A
not-an-email,B
ok2@x.com,C`;
    const r = parseUsersCsv(csv);
    expect(r.rows.map((x) => x.email)).toEqual(['ok@x.com', 'ok2@x.com']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(3);
    expect(r.errors[0].message).toMatch(/invalid email/i);
  });

  it('empty email field is a per-line error', () => {
    const csv = `email,first_name
,A
ok@x.com,B`;
    const r = parseUsersCsv(csv);
    expect(r.rows.map((x) => x.email)).toEqual(['ok@x.com']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/empty email/i);
    expect(r.errors[0].line).toBe(2);
  });

  it('invalid role → per-line error', () => {
    const csv = `email,role
ana@x.com,godmode
ok@x.com,member`;
    const r = parseUsersCsv(csv);
    expect(r.rows.map((x) => x.email)).toEqual(['ok@x.com']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/invalid role/i);
    expect(r.errors[0].message).toMatch(/godmode/);
  });

  it('duplicate emails within the same CSV → only first kept, rest reported', () => {
    const csv = `email
ana@x.com
ana@x.com
ana@x.com`;
    const r = parseUsersCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0].message).toMatch(/duplicate email/i);
    expect(r.errors[0].line).toBe(3);
    expect(r.errors[1].line).toBe(4);
  });

  it('line numbers are 1-based and match the original file', () => {
    // Header on line 1; first data row on line 2; the error row on line 5.
    const csv = `email,first_name
ok@x.com,A
ok2@x.com,B

bad-email,C`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(5);
  });

  it('valid roles are: admin, super_admin, member, editor, viewer', () => {
    const csv = `email,role
a@x.com,admin
b@x.com,super_admin
c@x.com,member
d@x.com,editor
e@x.com,viewer`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(5);
  });
});

describe('parseUsersCsv — adversarial edge cases', () => {
  it('only a header row → no rows, no errors', () => {
    const r = parseUsersCsv('email');
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('handles 1000 rows without throwing', () => {
    const lines = ['email,first_name'];
    for (let i = 0; i < 1000; i++) lines.push(`u${i}@x.com,User${i}`);
    const r = parseUsersCsv(lines.join('\n'));
    expect(r.rows).toHaveLength(1000);
    expect(r.errors).toEqual([]);
  });

  it('extra whitespace around fields is trimmed', () => {
    const csv = `email,first_name
   ana@x.com  ,  Ana   `;
    const r = parseUsersCsv(csv);
    expect(r.rows[0].email).toBe('ana@x.com');
    expect(r.rows[0].firstName).toBe('Ana');
  });

  it('semicolons embedded in a quoted comma-CSV field stay literal', () => {
    const csv = `email,first_name
ana@x.com,"Ana; María"`;
    const r = parseUsersCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].firstName).toBe('Ana; María');
  });

  it('returns the detected separator so the UI can show it', () => {
    expect(parseUsersCsv('email\na@x.com').separator).toBe(',');
    expect(parseUsersCsv('email;rol\na@x.com;member').separator).toBe(';');
  });
});
