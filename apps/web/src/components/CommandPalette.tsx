import { useEffect } from 'react';
import { Command } from 'cmdk';
import { useApp } from '../shell/AppContext';
import { FileText, Network, Plus, Search, Settings, Star } from '../icons';

/**
 * Linear / Vercel-style command palette built on cmdk.
 * - Opens / closes via `open` prop driven by Ctrl/Cmd+K.
 * - Fuzzy-search across notes + a curated list of actions.
 * - Selecting a note opens it as a tab; actions invoke their handler.
 */
export function CommandPalette({
  open,
  onClose,
  onNew,
}: {
  open: boolean;
  onClose: () => void;
  onNew: () => void;
}) {
  const { notes, openNote, openGraph, openSettings } = useApp();

  // Close on Escape (cmdk wires this internally but we wire blur on the wrapper too).
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      data-testid="quick-switcher"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Command
        label="Command palette"
        className="w-[640px] max-w-[92vw] rounded-lg border border-line bg-bg-surface shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 border-b border-line">
          <Search size={16} className="text-ink-muted" />
          <Command.Input
            autoFocus
            placeholder="Type a command or search notes…"
            className="flex-1 bg-transparent py-3 text-sm outline-none text-ink placeholder:text-ink-muted"
          />
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-sm text-ink-muted text-center">
            No matches.
          </Command.Empty>

          <Command.Group heading="Actions" className="text-[11px] uppercase tracking-wider text-ink-muted px-2 py-1">
            <Item
              onSelect={() => {
                onClose();
                onNew();
              }}
              icon={<Plus size={14} />}
              label="New note"
              hint="Ctrl N"
            />
            <Item
              onSelect={() => {
                onClose();
                openGraph();
              }}
              icon={<Network size={14} />}
              label="Open graph"
            />
            <Item
              onSelect={() => {
                onClose();
                openSettings();
              }}
              icon={<Settings size={14} />}
              label="Settings"
              hint="Ctrl ,"
            />
          </Command.Group>

          {notes.length > 0 && (
            <Command.Group heading="Notes" className="text-[11px] uppercase tracking-wider text-ink-muted px-2 py-1 mt-1">
              {notes.map((n) => (
                <Item
                  key={n.id}
                  onSelect={() => {
                    onClose();
                    openNote(n.id);
                  }}
                  icon={
                    n.favorite ? (
                      <Star size={14} className="text-yellow-300 fill-yellow-300" />
                    ) : (
                      <FileText size={14} className="text-ink-muted" />
                    )
                  }
                  label={n.title}
                />
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}

function Item({
  onSelect,
  icon,
  label,
  hint,
}: {
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2 px-2 py-2 text-sm rounded cursor-pointer text-ink data-[selected=true]:bg-brand data-[selected=true]:text-white"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {hint && <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-bg border border-line">{hint}</kbd>}
    </Command.Item>
  );
}
