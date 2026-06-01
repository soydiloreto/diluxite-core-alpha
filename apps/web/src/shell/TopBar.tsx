import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Command } from 'cmdk';
import { useApp } from './AppContext';
import {
  Bell,
  FileText,
  Folder,
  Hash,
  Network,
  Plug,
  Plus,
  Search,
  Settings,
  Shield,
  Star,
  X,
} from '../icons';

export interface TopBarHandle {
  /** Focus the search input + open the dropdown. */
  focusSearch: (initial?: string) => void;
}

/**
 * Top bar — VS Code-style. Three slots from left to right:
 *
 *   [brand]  ───────  [search input + dropdown]  ───────  [notifications]
 *
 * The search input is the app's single discovery surface, replacing the
 * old centered modal palette. Modes are inferred from the leading
 * character of the query:
 *
 *   default    → fuzzy match on note titles
 *   `>`        → commands (New note, Open graph, Settings)
 *   `#`        → tag picker (no suffix) or notes carrying a matching tag
 *
 * Dropdown is a `Command` (cmdk) anchored to the input. Esc closes,
 * click outside closes, picking an item closes and runs its action.
 *
 * The bell on the right is a placeholder for a notifications inbox —
 * wired to an empty popover today; the slot exists so we can hang a
 * real system on it without re-shuffling the top bar later.
 */
export const TopBar = forwardRef<
  TopBarHandle,
  {
    onNewNote: () => void;
    /** Crea una carpeta nueva en el root del workspace activo. */
    onNewFolder?: () => void;
    /** Crea un workspace nuevo (sólo si el user tiene permiso). */
    onNewWorkspace?: () => void;
    /** Abre el AdminConsole (sólo si el user tiene rol admin en alguna org). */
    onOpenAdmin?: () => void;
    brandLabel?: string;
    /** Workspace selector rendered centered between the brand and the search input. */
    workspaceSelector?: React.ReactNode;
    /** Organization indicator / switcher rendered next to the notifications bell. */
    orgIndicator?: React.ReactNode;
  }
>(function TopBar(
  {
    onNewNote,
    onNewFolder,
    onNewWorkspace,
    onOpenAdmin,
    brandLabel = 'Diluxite',
    workspaceSelector,
    orgIndicator,
  },
  ref,
) {
  const { notes, tags, openNote, openGraph, openSettings } = useApp();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch(initial?: string) {
      if (initial !== undefined) setQuery(initial);
      setOpen(true);
      // Give the focus call one tick so the input has rendered when we land.
      queueMicrotask(() => inputRef.current?.focus());
    },
  }));

  useEffect(() => {
    if (!open && !notifOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (open && !containerRef.current?.contains(t)) setOpen(false);
      if (notifOpen && !notifRef.current?.contains(t)) setNotifOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, notifOpen]);

  function close() {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }

  const mode: 'commands' | 'tags' | 'notes' = query.startsWith('>')
    ? 'commands'
    : query.startsWith('#')
      ? 'tags'
      : 'notes';
  const term = mode === 'notes' ? query : query.slice(1).trimStart();
  const termLower = term.toLowerCase();

  const filteredNotes = useMemo(() => {
    if (mode !== 'notes') return [];
    if (!term) return notes.slice(0, 50);
    return notes.filter((n) => n.title.toLowerCase().includes(termLower)).slice(0, 50);
  }, [mode, term, termLower, notes]);

  const filteredTags = useMemo(() => {
    if (mode !== 'tags') return [];
    if (!term) return tags;
    return tags.filter((t) => t.tag.toLowerCase().includes(termLower));
  }, [mode, term, termLower, tags]);

  // Notes carrying the exact tag the user is "in" — e.g. query `#azure`
  // surfaces notes that contain `#azure` in their content.
  const notesForExactTag = useMemo(() => {
    if (mode !== 'tags' || !term) return [];
    const needle = `#${termLower}`;
    return notes
      .filter((n) => n.contentMd.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [mode, term, termLower, notes]);

  return (
    <div className="h-9 shrink-0 flex items-center gap-2 sm:gap-3 bg-bg-surface border-b border-line px-2 sm:px-3 z-30 relative">
      <div className="shrink-0">
        <span className="text-xs sm:text-sm font-semibold tracking-wide text-ink">
          {brandLabel.toUpperCase()}
        </span>
      </div>

      {/* Spacer — pushes the search to the centre. The workspace selector
          moved to the right side, next to the org indicator (see below)
          so "you are in org X / workspace Y" reads in one glance. */}
      <div className="hidden sm:flex flex-1 min-w-0"></div>

      <div ref={containerRef} className="relative flex-1 sm:flex-none sm:w-full max-w-[560px] min-w-0">
        <Command label="Top bar search" shouldFilter={false} className="w-full">
          <div
            className={`flex items-center gap-2 px-3 h-7 rounded border bg-bg transition-colors ${
              open ? 'border-brand' : 'border-line hover:border-brand/40'
            }`}
          >
            <Search size={13} className="text-ink-muted shrink-0" />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder="Search notes — type > for commands, # for tags"
              className="flex-1 text-xs bg-transparent outline-none text-ink placeholder:text-ink-muted"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="clear search"
                className="text-ink-muted hover:text-ink shrink-0"
              >
                <X size={12} />
              </button>
            )}
            <kbd className="text-[10px] text-ink-muted px-1 py-0.5 rounded bg-bg-surface border border-line shrink-0">
              ⌘K
            </kbd>
          </div>

          {open && (
            <div className="absolute left-0 right-0 top-full mt-1 rounded-md border border-line bg-bg-surface shadow-2xl overflow-hidden">
              <Command.List className="max-h-[60vh] overflow-y-auto p-1">
                <Command.Empty className="px-3 py-6 text-xs text-ink-muted text-center">
                  No matches.
                </Command.Empty>

                {mode === 'commands' && (
                  <Command.Group heading="Commands" className="text-[10px] uppercase tracking-wider text-ink-muted px-2 py-1">
                    <Item
                      icon={<Plus size={13} />}
                      label="New note"
                      hint="Ctrl N"
                      onSelect={() => {
                        close();
                        onNewNote();
                      }}
                    />
                    {onNewFolder && (
                      <Item
                        icon={<Folder size={13} />}
                        label="New folder"
                        onSelect={() => {
                          close();
                          onNewFolder();
                        }}
                      />
                    )}
                    {onNewWorkspace && (
                      <Item
                        icon={<Folder size={13} />}
                        label="New workspace"
                        onSelect={() => {
                          close();
                          onNewWorkspace();
                        }}
                      />
                    )}
                    <Item
                      icon={<Network size={13} />}
                      label="Open graph"
                      onSelect={() => {
                        close();
                        openGraph();
                      }}
                    />
                    <Item
                      icon={<Plug size={13} />}
                      label="Connect AI (MCP)"
                      onSelect={() => {
                        close();
                        openSettings('connect');
                      }}
                    />
                    <Item
                      icon={<Plus size={13} />}
                      label="Create API key (MCP)"
                      onSelect={() => {
                        close();
                        openSettings('mcp');
                      }}
                    />
                    {onOpenAdmin && (
                      <Item
                        icon={<Shield size={13} />}
                        label="Open Admin"
                        onSelect={() => {
                          close();
                          onOpenAdmin();
                        }}
                      />
                    )}
                    <Item
                      icon={<Settings size={13} />}
                      label="Settings"
                      hint="Ctrl ,"
                      onSelect={() => {
                        close();
                        openSettings();
                      }}
                    />
                  </Command.Group>
                )}

                {mode === 'tags' && (
                  <>
                    <Command.Group heading="Tags" className="text-[10px] uppercase tracking-wider text-ink-muted px-2 py-1">
                      {filteredTags.length === 0 && (
                        <div className="text-xs text-ink-muted px-2 py-2">No tags match.</div>
                      )}
                      {filteredTags.map((tg) => (
                        <Item
                          key={tg.tag}
                          icon={<Hash size={13} />}
                          label={`#${tg.tag}`}
                          hint={`${tg.count} notes`}
                          onSelect={() => {
                            // Land on `#<tag>` so the bottom group reveals the notes.
                            setQuery(`#${tg.tag}`);
                          }}
                        />
                      ))}
                    </Command.Group>
                    {term && notesForExactTag.length > 0 && (
                      <Command.Group
                        heading={`Notes tagged #${term}`}
                        className="text-[10px] uppercase tracking-wider text-ink-muted px-2 py-1 mt-1"
                      >
                        {notesForExactTag.map((n) => (
                          <Item
                            key={n.id}
                            icon={
                              n.favorite ? (
                                <Star size={13} className="text-yellow-300 fill-yellow-300" />
                              ) : (
                                <FileText size={13} />
                              )
                            }
                            label={n.title}
                            onSelect={() => {
                              close();
                              openNote(n.id);
                            }}
                          />
                        ))}
                      </Command.Group>
                    )}
                  </>
                )}

                {mode === 'notes' && (
                  <Command.Group heading="Notes" className="text-[10px] uppercase tracking-wider text-ink-muted px-2 py-1">
                    {filteredNotes.map((n) => (
                      <Item
                        key={n.id}
                        icon={
                          n.favorite ? (
                            <Star size={13} className="text-yellow-300 fill-yellow-300" />
                          ) : (
                            <FileText size={13} />
                          )
                        }
                        label={n.title}
                        onSelect={() => {
                          close();
                          openNote(n.id);
                        }}
                      />
                    ))}
                    {!term && notes.length > 50 && (
                      <div className="text-[11px] text-ink-muted px-2 py-2">
                        Showing first 50 of {notes.length}. Type to narrow.
                      </div>
                    )}
                  </Command.Group>
                )}
              </Command.List>

              <div className="border-t border-line px-3 py-1.5 text-[10px] text-ink-muted bg-bg flex items-center gap-3 flex-wrap">
                <span>
                  <kbd className="px-1 rounded bg-bg-surface border border-line">↑↓</kbd> navigate
                </span>
                <span>
                  <kbd className="px-1 rounded bg-bg-surface border border-line">↵</kbd> open
                </span>
                <span>
                  <kbd className="px-1 rounded bg-bg-surface border border-line">esc</kbd> close
                </span>
                <span className="flex-1" />
                <span>
                  <kbd className="px-1 rounded bg-bg-surface border border-line">&gt;</kbd> commands
                </span>
                <span>
                  <kbd className="px-1 rounded bg-bg-surface border border-line">#</kbd> tags
                </span>
              </div>
            </div>
          )}
        </Command>
      </div>

      {/* Right-side gutter: workspace selector + org indicator + notifications.
          Reading order matches the data hierarchy: workspace (the thing you
          are looking at right now) → org (the container). Hidden on < sm
          to give the search input room. */}
      <div className="hidden sm:flex flex-1 justify-end items-center gap-2 min-w-0">
        {workspaceSelector ?? null}
        {orgIndicator ?? null}
      </div>

      <div ref={notifRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setNotifOpen((v) => !v)}
          aria-label="notifications"
          title="Notifications"
          className={`p-1.5 rounded hover:bg-bg ${
            notifOpen ? 'bg-bg text-ink' : 'text-ink-muted hover:text-ink'
          }`}
        >
          <Bell size={14} />
        </button>
        {notifOpen && (
          <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-line bg-bg-surface shadow-2xl p-3 text-xs text-ink-muted">
            <p className="font-medium text-ink mb-1">Notifications</p>
            <p>You're all caught up.</p>
          </div>
        )}
      </div>
    </div>
  );
});

function Item({
  icon,
  label,
  hint,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer text-ink data-[selected=true]:bg-brand data-[selected=true]:text-white"
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] text-ink-muted">{hint}</span>}
    </Command.Item>
  );
}
