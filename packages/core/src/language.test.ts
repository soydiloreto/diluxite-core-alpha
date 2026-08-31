import { describe, it, expect } from 'vitest';
import { detectLanguage, scoreLanguages, ftsConfigFor, DEFAULT_LANGUAGE } from './language';

describe('detectLanguage', () => {
  it('recognises a note in each of the four languages', () => {
    expect(
      detectLanguage(
        'La búsqueda combina BM25 con pgvector y fusiona los dos rankings con RRF. ' +
          'Después un reranker reordena los mejores por cobertura de términos.',
      ),
    ).toBe('es');
    expect(
      detectLanguage(
        'Search combines BM25 with pgvector and fuses both rankings with RRF. ' +
          'A reranker then reorders the best ones by term coverage.',
      ),
    ).toBe('en');
    expect(
      detectLanguage(
        'A busca combina BM25 com pgvector e funde os dois rankings com RRF. ' +
          'Depois um reranker reordena os melhores por cobertura de termos.',
      ),
    ).toBe('pt');
    expect(
      detectLanguage(
        'La ricerca combina BM25 con pgvector e fonde le due classifiche con RRF. ' +
          'Poi un reranker riordina i migliori per copertura dei termini.',
      ),
    ).toBe('it');
  });

  it('separates the two that share the most vocabulary', () => {
    // es/pt is the hard pair: same Latin roots, same function words in many
    // sentences. What separates them is `ão`/`ç`, `não`/`no`, `é`/`es`.
    expect(detectLanguage('As alterações são gravadas automaticamente nos servidores')).toBe('pt');
    expect(detectLanguage('Los cambios se guardan automáticamente en los servidores')).toBe('es');
  });

  it('does not let a code block vote', () => {
    // Every identifier in a fence is English. A Spanish note that happens to
    // paste a shell session must not be indexed as English.
    const note = [
      'Para levantar el stack, corré esto y esperá a que la base esté sana:',
      '',
      '```bash',
      'docker compose up -d',
      'for i in $(seq 1 10); do if pg_isready; then break; fi; done',
      '```',
      '',
      'Si el healthcheck no pasa, mirá los logs del contenedor.',
    ].join('\n');
    expect(detectLanguage(note)).toBe('es');
  });

  it('falls back rather than guessing when the text says nothing', () => {
    // A title-only note, an acronym, a URL: nothing here is a function word
    // in any of the four, so there is no signal to read.
    // The URL is in there on purpose: `.com` is a Portuguese function word,
    // and a bare link used to be detected as Portuguese with confidence.
    for (const mute of ['pgvector', 'TODO', 'https://example.com/a/b', '', '   ']) {
      const guess = scoreLanguages(mute);
      expect(guess.confident).toBe(false);
      expect(guess.language).toBe(DEFAULT_LANGUAGE);
    }
  });

  it('falls back when two languages explain the text equally well', () => {
    // "de" belongs to es and pt, "la" to es and it — a fragment made only of
    // shared words has no winner, and picking one would be a coin flip that
    // decides how the note is stemmed.
    const guess = scoreLanguages('de la');
    expect(guess.confident).toBe(false);
  });

  it('reads a short but unmistakable line', () => {
    // Three words, one of them orthographically impossible in the other
    // three languages.
    expect(detectLanguage('El año que viene')).toBe('es');
    expect(detectLanguage('As informações são públicas')).toBe('pt');
  });

  it('maps to the Postgres configuration the lexical channel needs', () => {
    expect(ftsConfigFor('The backup stores the database and the secrets')).toBe('english');
    expect(ftsConfigFor('Le modifiche viaggiano su WebSocket e vengono unite')).toBe('italian');
    expect(ftsConfigFor('As alterações viajam por WebSocket e são mescladas')).toBe('portuguese');
    expect(ftsConfigFor('Los cambios viajan por WebSocket y se fusionan')).toBe('spanish');
  });
});
