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
    // DOMPurify re-serializa atributos (un `<` literal es válido dentro de
    // comillas), así que validamos el valor parseado, no el escape crudo.
    const doc = new DOMParser().parseFromString(renderMarkdown('[[<x>]]'), 'text/html');
    const a = doc.querySelector('a.wikilink')!;
    expect(a.getAttribute('data-note')).toBe('<x>');
    expect(a.textContent).toBe('<x>');
    // El target nunca queda como elemento HTML real.
    expect(doc.querySelector('x')).toBeNull();
  });

  // ── Sanitización (stored XSS) ─────────────────────────────────────────
  it('elimina event handlers inline (onerror)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('elimina <script> embebido en la nota', () => {
    expect(renderMarkdown('hola <script>alert(1)</script>')).not.toContain('<script');
  });

  it('bloquea hrefs javascript:', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('los wikilinks sobreviven a la sanitización con sus data-attrs', () => {
    const html = renderMarkdown('ver [[Ideas|mis ideas]]');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-note="Ideas"');
    expect(html).toContain('>mis ideas<');
  });

  it('el markdown normal sigue rindiendo igual', () => {
    expect(renderMarkdown('# Título')).toContain('<h1');
    expect(renderMarkdown('- uno\n- dos')).toContain('<li>');
    expect(renderMarkdown('`code`')).toContain('<code>');
    expect(renderMarkdown('**negrita**')).toContain('<strong>');
  });
});
