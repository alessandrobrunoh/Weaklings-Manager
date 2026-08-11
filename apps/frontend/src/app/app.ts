import { ChangeDetectionStrategy, Component, inject, PLATFORM_ID } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';

import { AuthService } from './core/services/auth.service';

/**
 * Application root component.
 *
 * It owns no layout of its own — every route either renders the authenticated
 * `<app-shell>` or a stand-alone public page (e.g. `/login`). Here we only
 * trigger the initial session probe on app bootstrap.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);

  constructor() {
    // Probe session eagerly — skip on SSR where no backend is reachable.
    if (isPlatformBrowser(this.platformId)) {
      void this.auth.load();
    }
  }
}
