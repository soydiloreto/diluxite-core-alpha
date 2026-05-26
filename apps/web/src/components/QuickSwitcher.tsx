import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../api';
import { Modal, Input } from '../ui';

/** Modal estilo Obsidian "Quick switcher" — Ctrl/Cmd+K. Fuzzy por título. */
export function QuickSwitcher({
  open,
  onClose,
  notes,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  notes: Note[];
  onOpen: (n: Note) => void;
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return notes.slice(0, 30);
    return notes.filter((n) => n.titulo.toLowerCase().includes(needle)).slice(0, 30);
  }, [q, notes]);

  function pick(n: Note) {
    onOpen(n);
    onClose();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const n = filtered[idx];
      if (n) pick(n);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Buscar nota" size="md">
      <div className="flex flex-col" data-testid="quick-switcher">
        <div className="px-3 pt-3 pb-2 border-b border-line">
          <Input
            ref={inputRef}
            aria-label="quick switcher"
            placeholder="Empezá a tipear el título…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
            className="w-full"
          />
        </div>
        <ul className="max-h-[50vh] overflow-auto">
          {filtered.map((n, i) => (
            <li key={n.id}>
              <button
                onClick={() => pick(n)}
                onMouseEnter={() => setIdx(i)}
                className={`w-full text-left px-3 py-2 text-sm ${
                  i === idx ? 'bg-brand text-white' : 'hover:bg-bg'
                }`}
              >
                {n.titulo}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-3 text-sm text-ink-muted">Sin resultados.</li>
          )}
        </ul>
        <div className="px-3 py-2 border-t border-line text-xs text-ink-muted">
          ↑↓ para navegar · Enter para abrir · Esc para cerrar
        </div>
      </div>
    </Modal>
  );
}
