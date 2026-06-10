import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Where Vite forwards /api and /mcp in dev. Defaults to localhost so `pnpm dev`
// keeps working; inside docker-compose the `web` container sets API_TARGET to
// `http://api:3030` so it reaches the sibling service.
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:3030';
// The collab WebSocket (Hocuspocus) listens on its own port. In docker the
// nginx of the web image proxies /collab → api:3031; in dev Vite has to do
// the same or `collabUrl: '/collab'` points at nothing and the editor never
// connects.
const COLLAB_TARGET = process.env.COLLAB_TARGET ?? 'http://localhost:3031';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': API_TARGET,
      '/mcp': API_TARGET,
      '/collab': { target: COLLAB_TARGET, ws: true },
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
