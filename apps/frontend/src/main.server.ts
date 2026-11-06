import type { IncomingMessage, ServerResponse } from 'node:http';

import { mergeApplicationConfig, provideEnvironmentInitializer, inject } from '@angular/core';
import type { BootstrapContext } from '@angular/platform-browser';
import { bootstrapApplication } from '@angular/platform-browser';
import { renderApplication } from '@angular/platform-server';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { App } from './app/app';
import { config } from './app/app.config.server';
import { SERVER_REQUEST_CONTEXT } from './app/core/tokens/server-request.token';

/**
 * Per-request context Analog passes as the third argument to `render`.
 * `req` carries the browser's cookies; `res` lets the render set headers and
 * the status code.
 */
export interface AnalogServerContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

/**
 * Server entry point.
 *
 * Analog's Nitro layer calls this as `render(url, document, { req, res })`,
 * whereas the Angular CLI expected a bare `bootstrap(context)` export.
 * `renderApplication` supplies the `BootstrapContext` that Angular requires on
 * the server, so the bootstrap itself stays exactly as it was.
 *
 * Per request, this:
 *  - hands the incoming `Cookie` header to the app, so the session probe runs
 *    as the user (see `serverSessionInterceptor`);
 *  - marks the response `private, no-store`, since it depends on the session;
 *  - answers a guard redirect with a real HTTP redirect. The browser then
 *    renders the destination once, instead of the server rendering one page at
 *    the requested URL and the client router replacing it after hydration.
 */
export default async function render(
  url: string,
  document: string,
  context?: AnalogServerContext,
): Promise<string> {
  context?.res.setHeader('Cache-Control', 'private, no-store');

  // Written by the router subscription below, read after the render settles.
  const landing: { redirectTo: string | null } = { redirectTo: null };

  const requestConfig = mergeApplicationConfig(config, {
    providers: [
      {
        provide: SERVER_REQUEST_CONTEXT,
        useValue: { cookie: context?.req.headers.cookie ?? null },
      },
      provideEnvironmentInitializer(() => {
        const router = inject(Router);
        const requested = router.serializeUrl(router.parseUrl(url));
        router.events
          .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
          .subscribe((event) => {
            landing.redirectTo =
              event.urlAfterRedirects === requested ? null : event.urlAfterRedirects;
          });
      }),
    ],
  });

  const html = await renderApplication(
    (bootstrapContext: BootstrapContext) =>
      bootstrapApplication(App, requestConfig, bootstrapContext),
    { document, url },
  );

  if (landing.redirectTo !== null && context) {
    context.res.statusCode = 302;
    context.res.setHeader('Location', landing.redirectTo);
    return '';
  }
  return html;
}
