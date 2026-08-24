import { existsSync } from 'node:fs';
import path from 'node:path';

/** Guards `loadRootEnvOnce` so the file is only ever read once per process. */
let rootEnvLoaded = false;

/**
 * Loads the monorepo root `.env` into `process.env`, once, so the frontend's
 * dev server sees the same `BACKEND_PORT` (and anything else) the backend
 * itself reads from that file — without duplicating it into a second `.env`
 * under `apps/frontend`. Node's loader never overrides a variable the process
 * was already started with, so this can never fight an explicit
 * `BACKEND_PORT=...` or `API_REWRITE_URL=...` set in the actual shell.
 *
 * A no-op in production: the Docker image has no repo checkout alongside it,
 * and `API_REWRITE_URL` is always set explicitly there instead.
 *
 * Called lazily from `backendTarget()` rather than at module scope — Nitro's
 * dev bundler produced a "Cannot access before initialization" error when
 * this ran as a top-level side effect, which reads as a module-ordering quirk
 * in how it rolls up server routes. Deferring it to first use sidesteps that
 * entirely and costs nothing, since nothing needs it before the first request.
 *
 * The root path is resolved from `process.cwd()` rather than
 * `import.meta.dirname`: Vite's SSR module transform does not special-case
 * that property the way it does `import.meta.url`, so it comes through as
 * `undefined` under the dev bundler even though the same code runs fine once
 * built. `process.cwd()` is reliably `apps/frontend` in dev, since that is
 * always where `npm run dev` is invoked from.
 */
function loadRootEnvOnce(): void {
  if (rootEnvLoaded || process.env['NODE_ENV'] === 'production') {
    return;
  }
  rootEnvLoaded = true;
  const rootEnvPath = path.resolve(process.cwd(), '../../.env');
  if (!existsSync(rootEnvPath)) {
    return;
  }
  try {
    process.loadEnvFile(rootEnvPath);
  } catch {
    // Best-effort: a malformed root .env must not stop the dev server.
  }
}

/**
 * Resolves the backend base URL.
 *
 * In production the target is configuration: the backend runs as its own
 * service and the frontend container is the only thing the browser reaches.
 * In development it defaults to `http://localhost:${BACKEND_PORT}`, read from
 * the monorepo root `.env` above — the same port the backend itself binds —
 * falling back to 3000 when that file or the variable is absent.
 */
export function backendTarget(): string {
  loadRootEnvOnce();
  const configured = process.env['API_REWRITE_URL'];
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('API_REWRITE_URL is not configured.');
  }
  const port = process.env['BACKEND_PORT'] ?? '3000';
  return `http://localhost:${port}`;
}
