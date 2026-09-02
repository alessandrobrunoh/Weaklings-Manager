/**
 * Socket error codes a browser produces by walking away mid-request: a reload
 * during server-side rendering, a closed tab, a cancelled navigation.
 */
const CLIENT_DISCONNECT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE']);

/**
 * The disconnect code behind a rejection reason, or `null` when it is a real
 * failure that must still crash the process.
 *
 * Lives outside `plugins/` so it can be unit tested: importing the plugin
 * itself pulls in `nitropack/runtime`, which needs Nitro's virtual modules and
 * cannot be loaded under Vitest.
 */
export function clientDisconnectCode(reason: unknown): string | null {
  if (typeof reason !== 'object' || reason === null) {
    return null;
  }
  const code = (reason as { code?: unknown }).code;
  return typeof code === 'string' && CLIENT_DISCONNECT_CODES.has(code) ? code : null;
}
