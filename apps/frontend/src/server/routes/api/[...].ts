import { defineEventHandler, proxyRequest } from 'h3';

import { backendTarget } from '../../env';

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
