import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * SSR route configuration.
 *
 * Every route is rendered on-demand at request time (`RenderMode.Server`)
 * rather than prerendered at build time — the app is auth-gated, so build-time
 * prerendering would always render the unauthenticated shell and cannot reach
 * the backend anyway.
 */
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Server,
  },
];
