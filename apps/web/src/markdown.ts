import { marked } from 'marked';

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** Markdown → HTML, con wikilinks `[[Nota]]` / `[[Nota|alias]]` clicleables. */
export function renderMarkdown(md: string): string {
  const withLinks = md.replace(/\[\[([^\]]+)\]\]/g, (_, inner: string) => {
    const sep = inner.indexOf('|');
    const name = (sep === -1 ? inner : inner.slice(0, sep)).trim();
    const label = sep === -1 ? name : inner.slice(sep + 1).trim();
    if (!name) return '';
    return `<a href="#" class="wikilink" data-note="${escapeHtml(name)}">${escapeHtml(label)}</a>`;
  });
  return marked.parse(withLinks, { async: false });
}
