import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';

import { appConfig } from './app.config';

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
  providers: [provideServerRendering()],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
