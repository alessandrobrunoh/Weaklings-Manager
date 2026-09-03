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
import { AuthService } from '../../core/services/auth.service';
import { ADMIN_NAV_SECTIONS, APP_NAV_SECTIONS, ADMIN_ACCESS_PERMISSIONS, isAdminUrl } from '../nav';
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
  host: {
    '(document:keydown.escape)': 'closeDrawer()',
  },
  styles: `
    .workspace-main { padding: 1rem; }
    @media (min-width: 40rem) { .workspace-main { padding: 1.25rem; } }
    @media (min-width: 64rem) { .workspace-main { padding: 1.5rem; } }
  `,
  template: `
    <div class="flex h-dvh overflow-hidden bg-[var(--color-bg)]">
      <!-- Desktop sidebar -->
      <aside
        class="hidden md:flex flex-col shrink-0 transition-all duration-200 ease-in-out"
        [style.width]="isSidebarCollapsed() ? '56px' : '248px'"
        [style.min-width]="isSidebarCollapsed() ? '56px' : '248px'"
        [style.max-width]="isSidebarCollapsed() ? '56px' : '248px'"
        class="bg-[var(--color-surface)] border-r border-[var(--color-border)]"
      >
        <app-sidebar
          [sections]="navSections()"
          [ariaLabelKey]="navAriaLabelKey()"
          [collapsed]="isSidebarCollapsed()"
          (toggleCollapse)="toggleSidebarCollapse()"
        />
      </aside>

      <!-- Mobile drawer -->
      @if (isDrawerOpen()) {
        <div class="md:hidden fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <button
            type="button"
            class="absolute inset-0 bg-[color-mix(in_srgb,var(--color-void)_45%,transparent)]"
            (click)="closeDrawer()"
            aria-label="Close menu"
          ></button>
          <div
            class="relative w-72 max-w-[80%] flex flex-col h-full bg-[var(--color-surface)] border-r border-[var(--color-border)]"
          >
            <app-sidebar
              [sections]="navSections()"
              [ariaLabelKey]="navAriaLabelKey()"
              [collapsed]="false"
              (navigate)="closeDrawer()"
            />
          </div>
        </div>
      }

      <!-- Main column -->
      <div class="flex flex-1 flex-col min-w-0 overflow-hidden">
        <app-topbar (menuToggle)="toggleDrawer()" />
        <main #main class="workspace-main flex-1 overflow-y-auto overscroll-contain scrollbar-thin">
          <div class="w-full min-w-0">
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
  private readonly auth = inject(AuthService);
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');

  protected readonly isDrawerOpen = signal(false);
  protected readonly isSidebarCollapsed = signal(false);
  protected readonly inAdmin = signal(this.shouldUseAdminNavigation(this.router.url));
  protected readonly navSections = computed(() =>
    this.inAdmin() ? ADMIN_NAV_SECTIONS : APP_NAV_SECTIONS,
  );
  protected readonly navAriaLabelKey = computed(() =>
    this.inAdmin() ? 'nav.aria.admin' : 'nav.aria.primary',
  );

  private shouldUseAdminNavigation(url: string): boolean {
    const path = url.split('?')[0].split('#')[0];
    if (path === '/users' || path === '/users/' || path.startsWith('/users/')) {
      return ADMIN_ACCESS_PERMISSIONS.some((permission) => this.auth.hasPermission(permission));
    }
    return isAdminUrl(path);
  }

  constructor() {
    try {
      if (typeof localStorage !== 'undefined') {
        this.isSidebarCollapsed.set(
          localStorage.getItem('weaklings_sidebar_collapsed') === 'true',
        );
      }
    } catch {}

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
        this.inAdmin.set(this.shouldUseAdminNavigation(event.urlAfterRedirects));
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

  protected toggleSidebarCollapse(): void {
    this.isSidebarCollapsed.update((collapsed) => {
      const next = !collapsed;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('weaklings_sidebar_collapsed', String(next));
        }
      } catch {}
      return next;
    });
  }
}
