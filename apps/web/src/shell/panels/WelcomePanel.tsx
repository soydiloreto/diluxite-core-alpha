import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { Button, useContextMenu } from '../../ui';
import { useT } from '../../i18n';
import { Database, Plug, Plus, Settings } from '../../icons';

export function WelcomePanel(_props: IDockviewPanelProps) {
  const { openSettings } = useApp();
  const t = useT();
  const ctx = useContextMenu();

  function startNewNote() {
    window.dispatchEvent(new CustomEvent('diluxite:new-note'));
  }

  return (
    <div
      className="h-full flex items-center justify-center bg-bg p-8"
      onContextMenu={(e) =>
        ctx.open(e, [
          { label: 'New note', icon: <Plus size={13} />, onSelect: startNewNote },
          { label: 'Connect AI…', icon: <Plug size={13} />, onSelect: () => openSettings('connect') },
          { label: 'Settings', icon: <Settings size={13} />, onSelect: () => openSettings() },
        ])
      }
    >
      <div className="max-w-md text-center flex flex-col items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-brand-soft text-brand flex items-center justify-center">
          <Database size={28} />
        </div>
        <h1 className="text-2xl font-semibold text-ink">{t('empty.title')}</h1>
        <p className="text-sm text-ink-muted leading-relaxed">{t('empty.desc')}</p>
        <div className="flex gap-2 mt-2">
          <Button onClick={startNewNote}>
            <Plus size={16} /> {t('empty.newNote')}
          </Button>
          <Button variant="secondary" onClick={() => openSettings('connect')}>
            <Plug size={16} /> {t('empty.connect')}
          </Button>
        </div>
      </div>
      <ctx.Menu />
    </div>
  );
}
