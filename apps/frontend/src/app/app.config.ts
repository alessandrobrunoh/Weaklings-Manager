import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptorsFromDi } from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';

import { routes } from './app.routes';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';

/**
 * Root application providers.
 *
 * Adds `HttpClient` (with `fetch` for SSR), input-bound routing params,
 * view transitions for smooth route changes, and the SSR hydration bundle.
 *
 * No `withInMemoryScrolling` here: it resets `window.scrollTo`, but the shell
 * root is `h-screen overflow-hidden` (`layout/shell/shell.ts`) — the window
 * itself never scrolls in this app, every page scrolls inside `<main>`. The
 * router option would be a no-op; the real fix lives in `Shell`, which owns
 * that element and resets its `scrollTop` on navigation instead.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptorsFromDi()),
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideClientHydration(withEventReplay()),
  ],
};
