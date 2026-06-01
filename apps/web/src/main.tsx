import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppGate } from './shell/AppGate';
import { httpApi } from './api';
import { DialogProvider } from './ui';
// Dockview tabs / splitters / drop overlays. Imported from JS so Vite resolves
// the bare module specifier reliably (Tailwind's @import does not).
import 'dockview-react/dist/styles/dockview.css';
import './styles.css';

const api = httpApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogProvider>
      <AppGate api={api}>
        <App api={api} />
      </AppGate>
    </DialogProvider>
  </StrictMode>,
);
