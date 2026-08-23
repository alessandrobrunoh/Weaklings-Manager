import { defineEventHandler, proxyRequest } from 'h3';

/**
 * Resolves the backend base URL.
 *
 * In production the target is configuration: the backend runs as its own
 * service and the frontend container is the only thing the browser reaches.
 * In development it defaults to the local backend port, which is what the old
 * `proxy.conf.json` did — so `npm run dev` works with nothing configured.
 */
function backendTarget(): string {
  const configured = process.env['API_REWRITE_URL'];
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('API_REWRITE_URL is not configured.');
  }
  return 'http://localhost:3000';
}

/**
 * Gateway from the frontend server to the Rust backend.
 *
 * The browser only ever talks to this server: the backend is not exposed
 * directly, and relative `/api` calls made during server-side rendering would
 * otherwise loop straight back into this app and render it recursively until
 * the heap gives out. Both cases are handled here.
 *
 * `proxyRequest` forwards method, headers, body and response as-is, which is
 * what authentication needs — the session is an http-only cookie set by the
 * backend, so it has to survive the hop in both directions untouched.
 */
export default defineEventHandler((event) =>
  proxyRequest(event, `${backendTarget()}${event.node.req.url ?? '/'}`),
);
