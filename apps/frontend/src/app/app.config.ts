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
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptorsFromDi()),
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideClientHydration(withEventReplay()),
  ],
};
