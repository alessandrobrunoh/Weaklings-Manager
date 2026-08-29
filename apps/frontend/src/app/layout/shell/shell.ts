import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AlbionLinkGate } from '../../shared/components/albion-link-gate/albion-link-gate';
import { ADMIN_NAV_SECTIONS, APP_NAV_SECTIONS, isAdminUrl } from '../nav';
import { Sidebar } from '../sidebar/sidebar';
import { Topbar } from '../topbar/topbar';

/**
 * Top-level authenticated application shell.
 *
 * Holds the persistent layout (sidebar + topbar) and renders the active
 * feature route inside `<router-outlet>`. The sidebar collapses into a
 * drawer on narrow screens; on wide screens it is always visible.
 *
 * Navigation lives in `layout/nav.ts`. Under `/admin/*` the sidebar swaps to
 * the admin console; everywhere else it shows the guild app.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlbionLinkGate, RouterOutlet, Sidebar, Topbar],
  template: `
    <div class="flex h-screen overflow-hidden" style="background-color: var(--color-bg)">
      <!-- Desktop sidebar -->
      <aside
        class="hidden md:flex flex-col shrink-0"
        style="width: 260px; min-width: 260px; max-width: 260px; background-color: var(--color-surface); border-right: 1px solid var(--color-border)"
      >
        <app-sidebar [sections]="navSections()" [ariaLabelKey]="navAriaLabelKey()" />
      </aside>

      <!-- Mobile drawer -->
      @if (isDrawerOpen()) {
        <div class="md:hidden fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
          <button
            type="button"
            class="absolute inset-0"
            style="background-color: rgba(0,0,0,0.45)"
            (click)="closeDrawer()"
            aria-label="Close menu"
          ></button>
          <div
            class="relative w-72 max-w-[80%] flex flex-col h-full"
            style="background-color: var(--color-surface); box-shadow: var(--shadow-xl)"
          >
            <app-sidebar
              [sections]="navSections()"
              [ariaLabelKey]="navAriaLabelKey()"
              (navigate)="closeDrawer()"
            />
          </div>
        </div>
      }

      <!-- Main column -->
      <div class="flex flex-1 flex-col min-w-0 overflow-hidden">
        <app-topbar (menuToggle)="toggleDrawer()" />
        <main #main class="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 scrollbar-thin">
          <div class="mx-auto w-full max-w-[1200px]">
            <router-outlet />
          </div>
        </main>
      </div>

      <app-albion-link-gate />
    </div>
  `,
})
export class Shell {
  private readonly router = inject(Router);
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');

  protected readonly isDrawerOpen = signal(false);
  protected readonly inAdmin = signal(isAdminUrl(this.router.url));
  protected readonly navSections = computed(() =>
    this.inAdmin() ? ADMIN_NAV_SECTIONS : APP_NAV_SECTIONS,
  );
  protected readonly navAriaLabelKey = computed(() =>
    this.inAdmin() ? 'nav.aria.admin' : 'nav.aria.primary',
  );

  constructor() {
    // The router's own scroll restoration targets `window.scrollTo`, which is
    // a no-op here: the root is `h-screen overflow-hidden`, so the window
    // itself never scrolls — every page scrolls inside this `<main>`. Reset
    // it by hand on each navigation, or a long scrolled page (an event
    // detail, a battle breakdown) leaves its offset behind and the next page
    // renders mid-scroll instead of from the top.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        this.inAdmin.set(isAdminUrl(event.urlAfterRedirects));
        const element = this.main()?.nativeElement;
        if (element) {
          element.scrollTop = 0;
        }
      });
  }

  protected toggleDrawer(): void {
    this.isDrawerOpen.update((open) => !open);
  }

  protected closeDrawer(): void {
    this.isDrawerOpen.set(false);
  }
}
