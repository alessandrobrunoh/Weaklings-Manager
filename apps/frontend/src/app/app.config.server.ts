import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';

import { appConfig } from './app.config';
import { API_BASE_URL } from './core/tokens/api-base.token';
import { backendTarget } from '../server/env';

/**
 * Backend URL used by server-side renders.
 *
 * Renders call the backend directly (not through the `/api` gateway, which
 * would loop back into this server). `BACKEND_INTERNAL_URL` names that origin;
 * without it the gateway's own target is used, so one `API_REWRITE_URL` is
 * enough in production.
 */
export function serverApiBaseUrl(): string {
  const internal = process.env['BACKEND_INTERNAL_URL'];
  return internal ? internal.replace(/\/$/, '') : backendTarget();
}

/**
 * Server-side application config.
 *
 * Under the Angular CLI this also declared per-route render modes via
 * `@angular/ssr`'s `withRoutes`. Analog renders every request through
 * `renderApplication` instead, so that layer is gone — and it changed nothing
 * in practice, since every route was already rendered on demand: the app is
 * auth-gated, so build-time prerendering could only ever produce the
 * signed-out shell.
 */
const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(), { provide: API_BASE_URL, useFactory: serverApiBaseUrl }],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
