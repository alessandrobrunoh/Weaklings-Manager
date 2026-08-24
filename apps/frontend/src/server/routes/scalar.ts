import { defineEventHandler, proxyRequest } from 'h3';

import { backendTarget } from '../env';

/**
 * Gateway for the backend's OpenAPI documentation UI.
 *
 * Same reasoning as the `/api` gateway: the backend is not reachable from the
 * browser, so this server forwards the request.
 */
export default defineEventHandler((event) =>
  proxyRequest(event, `${backendTarget()}${event.node.req.url ?? '/scalar'}`),
);
