import { InjectionToken } from '@angular/core';

/**
 * Per-request data from the HTTP request that triggered a server render.
 *
 * Only set during SSR: `main.server.ts` provides it from Analog's server
 * context. In the browser nothing provides it, so the default `null` applies.
 */
export interface ServerRequestContext {
  /** The raw `Cookie` header of the incoming browser request, if any. */
  readonly cookie: string | null;
}

export const SERVER_REQUEST_CONTEXT = new InjectionToken<ServerRequestContext | null>(
  'SERVER_REQUEST_CONTEXT',
  { providedIn: 'root', factory: () => null },
);
