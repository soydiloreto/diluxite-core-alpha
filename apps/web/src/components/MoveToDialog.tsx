import { useMemo, useState } from 'react';
import type { Folder } from '../api';
import { Modal, Button, Select } from '../ui';

/**
 * Depth-aware, name-sorted folder list for the picker, skipping any forbidden
 * subtree (a folder being moved, plus its descendants — those would be cycles).
 */
function pickerOptions(
  folders: Folder[],
  forbidden: ReadonlySet<string>,
): { id: string; label: string }[] {
  const childFolders = (pid: string | null) =>
    folders.filter((c) => c.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
  const out: { id: string; label: string }[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const f of childFolders(pid)) {
      if (forbidden.has(f.id)) continue; // skip the whole forbidden subtree
      out.push({ id: f.id, label: `${'   '.repeat(depth)}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * "Move N items to…" destination picker for the multi-select move. Lists the
 * space's folders (indented) plus the root; folders that would form a cycle are
 * filtered out up front. Mount it only while open so the selection resets each
 * time it's shown.
 */
export function MoveToDialog({
  open,
  count,
  folders,
  forbidden,
  onPick,
  onClose,
}: {
  open: boolean;
  count: number;
  folders: Folder[];
  forbidden: ReadonlySet<string>;
  onPick: (targetFolderId: string | null) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => pickerOptions(folders, forbidden), [folders, forbidden]);
  const [value, setValue] = useState<string>(''); // '' = root

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Move ${count} item${count === 1 ? '' : 's'} to…`}
    >
      <div className="p-4 flex flex-col gap-4">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-ink-muted">Destination</span>
          <Select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="destination folder"
            autoFocus
          >
            <option value="">Root (no folder)</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onPick(value || null);
              onClose();
            }}
          >
            Move here
          </Button>
        </div>
      </div>
    </Modal>
  );
}
