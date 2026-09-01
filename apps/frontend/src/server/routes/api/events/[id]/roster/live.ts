import { defineWebSocketHandler } from 'h3';
import { createWebSocketProxy } from 'crossws';
import { WebSocket as NodeWebSocket } from 'ws';

import { backendTarget } from '../../../../../env';

/**
 * WebSocket gateway for the live event roster.
 *
 * The regular catch-all API proxy only forwards HTTP requests. This explicit
 * WebSocket handler performs the upgrade and forwards the browser session and
 * origin headers so the Rust backend can authenticate and validate the origin.
 */
const proxyHooks = createWebSocketProxy({
  target: (peer) => {
    const requestUrl = new URL(peer.request.url);
    const target = new URL(`${backendTarget()}${requestUrl.pathname}${requestUrl.search}`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    return target;
  },
  WebSocket: NodeWebSocket as unknown as typeof globalThis.WebSocket,
  headers: (peer) => ({
    cookie: peer.request.headers.get('cookie') ?? '',
    origin: peer.request.headers.get('origin') ?? '',
  }),
});

// h3 currently resolves its own compatible crossws copy. The hook contract is
// runtime-compatible, but TypeScript sees the two package instances as distinct.
export default defineWebSocketHandler(proxyHooks as Parameters<typeof defineWebSocketHandler>[0]);
