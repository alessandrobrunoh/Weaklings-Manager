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
 * Gateway for the backend's OpenAPI documentation UI.
 *
 * Same reasoning as the `/api` gateway: the backend is not reachable from the
 * browser, so this server forwards the request.
 */
export default defineEventHandler((event) =>
  proxyRequest(event, `${backendTarget()}${event.node.req.url ?? '/scalar'}`),
);
