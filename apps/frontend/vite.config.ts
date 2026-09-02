/// <reference types="vitest" />
import analog from '@analogjs/platform';
import { resolve } from 'node:path';
import { createLogger, defineConfig, loadEnv } from 'vite';

import { clientDisconnectCode } from './src/server/client-disconnect.ts';

/**
 * Survives a browser walking away mid-request.
 *
 * Node reports the aborted inbound socket as a rejected promise created inside
 * the request pipeline, with nothing for us to `catch`, so it lands as an
 * unhandled rejection and — under Node's default `--unhandled-rejections=throw`
 * — kills `npm run dev` outright with `Error: read ECONNRESET`. A reload landing
 * on a still-rendering page is enough to trigger it.
 *
 * The same guard is installed for the built server by
 * `src/server/plugins/client-disconnect.ts`; this one covers the dev server,
 * which serves requests from the Vite process rather than that Nitro app.
 * Registering any listener suppresses Node's default, so anything that is not a
 * disconnect is rethrown and still crashes loudly.
 */
let disconnectGuardInstalled = false;
function installClientDisconnectGuard(): void {
  if (disconnectGuardInstalled) {
    return;
  }
  disconnectGuardInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const code = clientDisconnectCode(reason);
    if (code === null) {
      throw reason;
    }
    viteLogger.warn(`[dev] client disconnected mid-request (${code})`);
  });
}

const viteLogger = createLogger();
const warn = viteLogger.warn.bind(viteLogger);
const warnOnce = viteLogger.warnOnce.bind(viteLogger);

function isAngularPlatformServerSourcemapWarning(message: string): boolean {
  return message.includes('Sourcemap for') && message.includes('@angular/platform-server');
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
      {
        name: 'weaklings:survive-client-disconnect',
        apply: 'serve',
        configureServer: installClientDisconnectGuard,
      },
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
      // Nitro's `experimental.websocket` installs its own `upgrade` handler on this same HTTP
      // server, and it answers Vite's HMR socket before Vite does. The HMR client then falls back
      // to a tokenless `ws://host/`, is refused, and reloads the page to get a fresh token — over
      // and over, every reload tearing down an in-flight server render. Giving HMR its own port
      // keeps the two off each other's upgrades without disabling the websocket support the live
      // roster route needs.
      hmr: { port: 5174 },
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
