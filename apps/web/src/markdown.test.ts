import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renderiza markdown básico', () => {
    expect(renderMarkdown('# Hola')).toContain('<h1');
    expect(renderMarkdown('**negrita**')).toContain('<strong>');
  });

  it('convierte wikilinks en enlaces clicleables', () => {
    const html = renderMarkdown('ver [[Ideas]]');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-note="Ideas"');
    expect(html).toContain('>Ideas<');
  });

  it('soporta alias [[Nota|alias]]', () => {
    const html = renderMarkdown('[[ConoSurTech|mi comunidad]]');
    expect(html).toContain('data-note="ConoSurTech"');
    expect(html).toContain('>mi comunidad<');
  });

  it('escapa HTML en el target', () => {
    expect(renderMarkdown('[[<x>]]')).toContain('data-note="&lt;x&gt;"');
  });
});
