import { defineNitroPlugin } from 'nitropack/runtime';

import { clientDisconnectCode } from '../client-disconnect';

/**
 * Keeps the frontend server alive when a client disconnects mid-request.
 *
 * Node surfaces the aborted inbound socket as a rejected promise created deep
 * inside the request pipeline, with no handle for us to attach a `catch` to, so
 * it arrives as an unhandled rejection — and under Node's default
 * `--unhandled-rejections=throw` that takes the whole process down with
 * `Error: read ECONNRESET at TCP.onStreamRead`. In development every browser
 * reload landing on a still-rendering page kills `npm run dev`; in production
 * one impatient visitor restarts the container.
 *
 * Registering any `unhandledRejection` listener suppresses that default, so the
 * handler rethrows anything that is not a disconnect: a genuine unhandled
 * rejection still crashes loudly, exactly as before.
 */
export default defineNitroPlugin(() => {
  process.on('unhandledRejection', (reason) => {
    const code = clientDisconnectCode(reason);
    if (code === null) {
      throw reason;
    }
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[server] client disconnected mid-request (${code})`);
    }
  });
});
