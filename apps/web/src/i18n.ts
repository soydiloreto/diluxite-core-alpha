import { useSettings } from './useSettings';

export type Lang = 'en' | 'es';
export const LANGS: Lang[] = ['en', 'es'];

const en = {
  // topbar
  'topbar.search': '⌘K Search',
  'topbar.graph': '🕸 Graph',
  'topbar.newNote': '+ New note',
  'topbar.settings': 'Settings',
  // dock
  'dock.searchPlaceholder': 'Search memory…',
  'dock.notes': 'Notes',
  'dock.recent': 'Recent',
  'dock.favorites': 'Favorites',
  'dock.tags': 'Tags',
  'dock.outline': 'Outline',
  'dock.empty': 'Empty. Create a note or folder from the buttons above.',
  'dock.noNotesYet': 'No notes yet.',
  'dock.markFavorite': 'Mark a note with ★ to pin it here.',
  'dock.useHashtag': 'Use #tag inside a note.',
  'dock.noHeadings': 'No headings.',
  'dock.newNote': 'New note',
  'dock.newFolder': 'New folder',
  'dock.newSubfolder': 'New subfolder',
  'dock.selected': '{n} selected',
  'dock.delete': 'Delete',
  'dock.cancel': 'Cancel',
  // editor
  'editor.edited': 'edited',
  'editor.favorite': 'Mark as favorite',
  'editor.unfavorite': 'Remove from favorites',
  'editor.delete': 'Delete',
  'editor.confirmDelete': 'Delete «{title}»?',
  'editor.yesDelete': 'Yes, delete',
  'editor.cancel': 'Cancel',
  'editor.close': 'Close note (Esc)',
  'editor.backlinks': 'Backlinks',
  'editor.noBacklinks': 'No notes link to this one.',
  // dialogs
  'dialog.cancel': 'Cancel',
  'dialog.ok': 'OK',
  // empty state
  'empty.title': 'Your memory is waiting',
  'empty.desc':
    'Create your first note from the left, or connect Claude over MCP (Settings → Connect AI) so it starts remembering and writing for you.',
  'empty.newNote': '+ New note',
  'empty.connect': 'Connect AI',
  // status bar
  'status.settings': '⚙ Settings',
  'status.mcp': '🟢 MCP',
  'status.space': '📂 My space',
  // settings tabs
  'settings.title': 'Settings',
  'settings.tab.connect': 'Connect AI',
  'settings.tab.appearance': 'Appearance',
  'settings.tab.search': 'Search',
  'settings.tab.ai': 'AI / Embeddings',
  'settings.tab.mcp': 'MCP connection',
  'settings.tab.space': 'Space',
  'settings.tab.about': 'About',
  // appearance
  'settings.appearance.title': 'Appearance',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.themeDark': 'Dark',
  'settings.appearance.themeLight': 'Light',
  'settings.appearance.accent': 'Accent color',
  'settings.appearance.language': 'Language',
};

const es: typeof en = {
  'topbar.search': '⌘K Buscar',
  'topbar.graph': '🕸 Grafo',
  'topbar.newNote': '+ Nueva nota',
  'topbar.settings': 'Ajustes',
  'dock.searchPlaceholder': 'Buscar en la memoria…',
  'dock.notes': 'Notas',
  'dock.recent': 'Recientes',
  'dock.favorites': 'Favoritas',
  'dock.tags': 'Tags',
  'dock.outline': 'Outline',
  'dock.empty': 'Vacío. Creá una nota o carpeta con los botones de arriba.',
  'dock.noNotesYet': 'Sin notas todavía.',
  'dock.markFavorite': 'Marcá una nota con ★ para fijarla acá.',
  'dock.useHashtag': 'Usá #tag dentro de una nota.',
  'dock.noHeadings': 'Sin headings.',
  'dock.newNote': 'Nueva nota',
  'dock.newFolder': 'Nueva carpeta',
  'dock.newSubfolder': 'Nueva subcarpeta',
  'dock.selected': '{n} seleccionadas',
  'dock.delete': 'Borrar',
  'dock.cancel': 'Cancelar',
  'editor.edited': 'editada',
  'editor.favorite': 'Marcar como favorita',
  'editor.unfavorite': 'Quitar de favoritas',
  'editor.delete': 'Borrar',
  'editor.confirmDelete': '¿Borrar «{title}»?',
  'editor.yesDelete': 'Sí, borrar',
  'editor.cancel': 'Cancelar',
  'editor.close': 'Cerrar nota (Esc)',
  'editor.backlinks': 'Backlinks',
  'editor.noBacklinks': 'Ninguna nota enlaza a esta.',
  'dialog.cancel': 'Cancelar',
  'dialog.ok': 'OK',
  'empty.title': 'Tu memoria está esperando',
  'empty.desc':
    'Creá tu primera nota desde la izquierda, o conectá Claude por MCP (Ajustes → Conectar IA) para que empiece a recordar y anotar por vos.',
  'empty.newNote': '+ Nueva nota',
  'empty.connect': 'Conectar IA',
  'status.settings': '⚙ Ajustes',
  'status.mcp': '🟢 MCP',
  'status.space': '📂 Mi espacio',
  'settings.title': 'Ajustes',
  'settings.tab.connect': 'Conectar IA',
  'settings.tab.appearance': 'Apariencia',
  'settings.tab.search': 'Búsqueda',
  'settings.tab.ai': 'IA / Embeddings',
  'settings.tab.mcp': 'Conexión MCP',
  'settings.tab.space': 'Espacio',
  'settings.tab.about': 'Acerca de',
  'settings.appearance.title': 'Apariencia',
  'settings.appearance.theme': 'Tema',
  'settings.appearance.themeDark': 'Oscuro',
  'settings.appearance.themeLight': 'Claro',
  'settings.appearance.accent': 'Color de marca',
  'settings.appearance.language': 'Idioma',
};

const catalogs: Record<Lang, typeof en> = { en, es };

export type MessageKey = keyof typeof en;

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let s = catalogs[lang]?.[key] ?? catalogs.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Hook de traducción. Por defecto en; cambia según prefs.lang. */
export function useT() {
  const { prefs } = useSettings();
  return (key: MessageKey, vars?: Record<string, string | number>) =>
    translate(prefs.lang, key, vars);
}
