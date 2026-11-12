import {
  ApplicationConfig,
  inject,
  PLATFORM_ID,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { isPlatformServer } from '@angular/common';
import {
  provideHttpClient,
  withFetch,
  withInterceptors,
  withInterceptorsFromDi,
} from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';

import { routes } from './app.routes';
import { serverSessionInterceptor } from './core/interceptors/server-session.interceptor';
import { accessBlockedInterceptor } from './core/interceptors/access-blocked.interceptor';
import { sessionExpiryInterceptor } from './core/interceptors/session-expiry.interceptor';
import { AuthService } from './core/services/auth.service';
import { bootSessionProbe } from './core/services/session-boot';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';

/**
 * Root application providers.
 *
 * Adds `HttpClient` (with `fetch` for SSR), input-bound routing params,
 * view transitions for smooth route changes, and the SSR hydration bundle.
 *
 * The session probe runs as an app initializer, so the first render (on the
 * server) and the first navigation already know whether a session exists. The
 * server forwards the browser's cookie to the backend; the browser reuses the
 * probe the server stored in `TransferState` instead of asking again. In the
 * browser the boot waits for the probe only up to a bound (see
 * `bootSessionProbe`), so a hung backend cannot keep the app on its splash.
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
    provideHttpClient(
      withFetch(),
      withInterceptors([
        serverSessionInterceptor,
        sessionExpiryInterceptor,
        accessBlockedInterceptor,
      ]),
      withInterceptorsFromDi(),
    ),
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideClientHydration(withEventReplay()),
    provideAppInitializer(() =>
      bootSessionProbe(inject(AuthService), isPlatformServer(inject(PLATFORM_ID))),
    ),
  ],
};
