import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { httpApi } from './api';
import { DialogProvider } from './ui';
// Dockview tabs / splitters / drop overlays. Imported from JS so Vite resolves
// the bare module specifier reliably (Tailwind's @import does not).
import 'dockview-react/dist/styles/dockview.css';
// Bundle Monaco locally + register its Web Worker (no CDN).
import './monaco-setup';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogProvider>
      <App api={httpApi()} />
    </DialogProvider>
  </StrictMode>,
);
