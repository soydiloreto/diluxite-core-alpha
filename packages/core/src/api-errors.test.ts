import { describe, it, expect } from 'vitest';
import {
  API_ERRORS,
  API_LOCALES,
  apiErrorMessage,
  DEFAULT_API_LOCALE,
  negotiateLocale,
} from './api-errors';

describe('negotiateLocale', () => {
  it('falls back to English with no header', () => {
    expect(negotiateLocale(undefined)).toBe('en');
    expect(negotiateLocale('')).toBe('en');
  });

  it('takes a plain tag', () => {
    expect(negotiateLocale('es')).toBe('es');
    expect(negotiateLocale('ZH')).toBe('zh');
  });

  it('falls back through the base language', () => {
    // A Brazilian browser sends pt-BR; a Rioplatense one sends es-AR.
    expect(negotiateLocale('pt-BR')).toBe('pt');
    expect(negotiateLocale('es-AR,es;q=0.9')).toBe('es');
  });

  it('honours quality values rather than taking the first tag', () => {
    expect(negotiateLocale('de;q=0.9,es;q=1.0')).toBe('es');
    expect(negotiateLocale('fr,it;q=0.8')).toBe('it');
  });

  it('skips a language explicitly refused with q=0', () => {
    expect(negotiateLocale('es;q=0,pt;q=0.5')).toBe('pt');
  });

  it('gives English for anything unsupported — a half-translated error is worse', () => {
    expect(negotiateLocale('de-DE,de;q=0.9')).toBe('en');
    expect(negotiateLocale('*')).toBe('en');
  });

  it('does not choke on a malformed header', () => {
    expect(negotiateLocale(';;;')).toBe('en');
    expect(negotiateLocale('es;q=notanumber')).toBe('es');
  });

  // The header is client-controlled and arbitrarily long.
  it('handles a very long header quickly', () => {
    const header = Array.from({ length: 5000 }, (_, i) => `xx${i};q=0.5`).join(',');
    const started = performance.now();
    expect(negotiateLocale(header)).toBe('en');
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('apiErrorMessage', () => {
  it('resolves a key in each locale', () => {
    expect(apiErrorMessage('note.notFound', 'en')).toBe('not found');
    expect(apiErrorMessage('note.notFound', 'es')).toBe('no encontrado');
    expect(apiErrorMessage('note.notFound', 'zh')).toBe('未找到');
  });

  it('interpolates placeholders verbatim, in every language', () => {
    expect(apiErrorMessage('role.invalid', 'es', { role: 'editor' })).toBe('rol inválido: editor');
    expect(apiErrorMessage('role.invalid', 'zh', { role: 'editor' })).toContain('editor');
  });

  // A missing translation must never turn a 400 into a 500, and returning the
  // key makes the omission visible instead of plausibly wrong.
  it('returns the key itself for an unknown key rather than throwing', () => {
    expect(apiErrorMessage('nope.notAKey', 'es')).toBe('nope.notAKey');
  });

  it('defaults to English', () => {
    expect(apiErrorMessage('note.notFound')).toBe(apiErrorMessage('note.notFound', 'en'));
  });
});

describe('the catalog itself', () => {
  it('has every locale for every key — a partial entry ships a blank error', () => {
    for (const [key, entry] of Object.entries(API_ERRORS)) {
      for (const locale of API_LOCALES) {
        expect(entry[locale], `${key} → ${locale}`).toBeTruthy();
      }
    }
  });

  it('keeps the same placeholders in every translation', () => {
    // A translation that drops `{role}` produces a message missing the one
    // piece of information the reader needed.
    const placeholders = (s: string) => (s.match(/\{[a-z]+\}/gi) ?? []).sort().join(',');
    for (const [key, entry] of Object.entries(API_ERRORS)) {
      const want = placeholders(entry[DEFAULT_API_LOCALE]);
      for (const locale of API_LOCALES) {
        expect(placeholders(entry[locale]), `${key} → ${locale}`).toBe(want);
      }
    }
  });
});
