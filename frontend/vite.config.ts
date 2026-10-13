/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev proxy follows PORT from the repo's .env, like the backend does.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': `http://localhost:${loadEnv(mode, '..', '').PORT || 3030}` } },
  build: { outDir: 'dist' },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/setupTests.ts'] },
}));
