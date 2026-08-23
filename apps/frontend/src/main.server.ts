import type { BootstrapContext } from '@angular/platform-browser';
import { bootstrapApplication } from '@angular/platform-browser';
import { renderApplication } from '@angular/platform-server';

import { App } from './app/app';
import { config } from './app/app.config.server';

/**
 * Server entry point.
 *
 * Analog's Nitro layer calls this as `render(url, document)`, whereas the
 * Angular CLI expected a bare `bootstrap(context)` export. The two differ in
 * shape but not in substance: `renderApplication` supplies the
 * `BootstrapContext` that Angular requires on the server, so the bootstrap
 * itself stays exactly as it was.
 */
export default async function render(url: string, document: string): Promise<string> {
  return renderApplication(
    (context: BootstrapContext) => bootstrapApplication(App, config, context),
    { document, url },
  );
}
