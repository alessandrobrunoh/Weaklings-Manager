/// <reference types="vitest" />
import analog from '@analogjs/platform';
import { defineConfig } from 'vite';

/**
 * Vite + Analog configuration.
 *
 * Replaces the Angular CLI builder and the Express SSR entry point. Two things
 * carried over from the previous setup and matter:
 *
 * - `/api` and `/scalar` proxy to the Rust backend. In development that is
 *   handled here; in production a Nitro route under `src/server/routes/`
 *   does the same job, because the frontend container is what the browser
 *   talks to and the backend is not exposed directly.
 * - Nothing is prerendered. Every route is auth-gated, so build-time rendering
 *   would only ever produce the signed-out shell.
 */
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    target: ['es2022'],
    reportCompressedSize: true,
  },
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    analog({
      ssr: true,
      static: false,
      prerender: {
        routes: [],
      },
      nitro: {
        preset: 'node-server',
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, secure: false },
      '/scalar': { target: 'http://localhost:3000', changeOrigin: true, secure: false },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['**/*.spec.ts'],
    reporters: ['default'],
  },
  define: {
    'import.meta.vitest': mode !== 'production',
  },
}));
