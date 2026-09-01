/// <reference types="vitest" />
import analog from '@analogjs/platform';
import { resolve } from 'node:path';
import { createLogger, defineConfig, loadEnv } from 'vite';

const viteLogger = createLogger();
const warn = viteLogger.warn.bind(viteLogger);
const warnOnce = viteLogger.warnOnce.bind(viteLogger);

function isAngularPlatformServerSourcemapWarning(message: string): boolean {
  return (
    message.includes('Sourcemap for') && message.includes('@angular/platform-server')
  );
}

viteLogger.warn = (message, options) => {
  if (!isAngularPlatformServerSourcemapWarning(message)) {
    warn(message, options);
  }
};
viteLogger.warnOnce = (message, options) => {
  if (!isAngularPlatformServerSourcemapWarning(message)) {
    warnOnce(message, options);
  }
};

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
export default defineConfig(({ mode }) => {
  // Load the shared repository environment so local frontend development uses
  // the same backend port as `cargo run`.
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  Object.assign(process.env, env);
  const backendTarget = env.API_REWRITE_URL ?? `http://localhost:${env.BACKEND_PORT ?? '3000'}`;

  return {
    customLogger: viteLogger,
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
          experimental: {
            websocket: true,
          },
        },
      }),
    ],
    server: {
      proxy: {
        '/api': { target: backendTarget, changeOrigin: true, secure: false },
        '/scalar': { target: backendTarget, changeOrigin: true, secure: false },
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
  };
});
