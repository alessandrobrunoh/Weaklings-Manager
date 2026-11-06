import type { AuthService } from './auth.service';

/** Longest the browser boot waits for the session probe before rendering anyway. */
export const SESSION_BOOT_WAIT_MS = 3000;

/**
 * Runs the session probe before the app boots.
 *
 * On the server the render needs the answer, so the boot waits for the probe
 * with no bound. In the browser the boot waits at most `waitMs`: a hung
 * backend must not keep the SPA on its splash. Past that bound the boot
 * continues and the probe keeps running; guards share the same promise via
 * `AuthService.load()`, so they still wait for the answer where it matters.
 * A probe that finishes in time (the usual case, with the server's
 * TransferState) makes the browser boot wait for nothing more than that.
 */
export function bootSessionProbe(
  auth: Pick<AuthService, 'load'>,
  isServer: boolean,
  waitMs: number = SESSION_BOOT_WAIT_MS,
): Promise<void> {
  const probe = auth.load().then(() => undefined);
  if (isServer) {
    return probe;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  return Promise.race([probe, bound]).finally(() => clearTimeout(timer));
}
