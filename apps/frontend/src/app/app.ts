import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { BrandingService } from './core/services/branding.service';

/**
 * Application root component.
 *
 * It owns no layout of its own — every route either renders the authenticated
 * `<app-shell>` or a stand-alone public page (e.g. `/login`). The initial
 * session probe runs as an app initializer (see `app.config.ts`); here we only
 * start the service that repaints the app in the active server's brand colours.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {
  /** Injected for its effect: nothing else references it. */
  private readonly branding = inject(BrandingService);
}
