import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { httpApi } from './api';
import { DialogProvider } from './ui';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogProvider>
      <App api={httpApi()} />
    </DialogProvider>
  </StrictMode>,
);
