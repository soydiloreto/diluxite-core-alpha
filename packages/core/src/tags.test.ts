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

  it('sin tags => []', () => {
    expect(parseTags('texto sin tags')).toEqual([]);
  });
});
