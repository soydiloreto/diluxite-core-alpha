import { describe, it, expect } from 'vitest';
import { parseTags } from './tags';

describe('parseTags', () => {
  it('extrae tags simples', () => {
    expect(parseTags('uso #azure y #mcp hoy')).toEqual(['azure', 'mcp']);
  });

  it('NO confunde un heading markdown con un tag', () => {
    expect(parseTags('# Título\n\ncontenido')).toEqual([]);
  });

  it('soporta tags anidados y guiones', () => {
    expect(parseTags('#area/proyecto y #dev-ops')).toEqual(['area/proyecto', 'dev-ops']);
  });

  it('deduplica case-insensitive preservando el primero', () => {
    expect(parseTags('#Azure #azure #AZURE')).toEqual(['Azure']);
  });

  it('no matchea # dentro de una palabra', () => {
    expect(parseTags('color#fff no es tag')).toEqual([]);
  });

  it('NO confunde un anchor de link markdown `](#...)` con un tag', () => {
    expect(parseTags('See [section](#intro) and #real-tag')).toEqual(['real-tag']);
  });

  it('un tag entre paréntesis sigue funcionando', () => {
    expect(parseTags('(#tag)')).toEqual(['tag']);
  });

  it('sin tags => []', () => {
    expect(parseTags('texto sin tags')).toEqual([]);
  });

  it('NO matchea # dentro de un code fence (```)', () => {
    const md = 'antes\n\n```c\n#include <foo>\n```\n\ndespués #real';
    expect(parseTags(md)).toEqual(['real']);
  });

  it('NO matchea # dentro de inline code (`...`)', () => {
    expect(parseTags('usá `#define X` pero #si vale')).toEqual(['si']);
  });
});
