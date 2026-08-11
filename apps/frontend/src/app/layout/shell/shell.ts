import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { AlbionLinkGate } from '../../shared/components/albion-link-gate/albion-link-gate';
import { Sidebar, type NavSection } from '../sidebar/sidebar';
import { Topbar } from '../topbar/topbar';

/**
 * Top-level authenticated application shell.
 *
 * Holds the persistent layout (sidebar + topbar) and renders the active
 * feature route inside `<router-outlet>`. The sidebar collapses into a
 * drawer on narrow screens; on wide screens it is always visible.
 *
 * The static `NAV_SECTIONS` lives here so the shell is the single source of
 * truth for navigation. To add a module, append an entry here and add the
 * matching route in `app.routes.ts`.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlbionLinkGate, RouterOutlet, Sidebar, Topbar],
  template: `
    <div class="flex h-screen overflow-hidden" style="background-color: var(--color-bg)">
      <!-- Desktop sidebar -->
      <aside
        class="hidden md:flex md:w-64 md:shrink-0 flex-col"
        style="background-color: var(--color-surface); border-right: 1px solid var(--color-border)"
      >
        <app-sidebar [sections]="NAV_SECTIONS" />
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
            class="relative w-72 max-w-[80%] flex flex-col"
            style="background-color: var(--color-surface); box-shadow: var(--shadow-3)"
          >
            <app-sidebar [sections]="NAV_SECTIONS" (navigate)="closeDrawer()" />
          </div>
        </div>
      }

      <!-- Main column -->
      <div class="flex flex-1 flex-col overflow-hidden">
        <app-topbar (menuToggle)="toggleDrawer()" />
        <main class="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 scrollbar-thin">
          <div class="mx-auto w-full max-w-7xl">
            <router-outlet />
          </div>
        </main>
      </div>

      <app-albion-link-gate />
    </div>
  `,
})
export class Shell {
  protected readonly isDrawerOpen = signal(false);

  protected toggleDrawer(): void {
    this.isDrawerOpen.update((open) => !open);
  }

  protected closeDrawer(): void {
    this.isDrawerOpen.set(false);
  }

  /**
   * Single source of truth for the navigation.
   *
   * Keeping it static avoids repeated allocation; the sidebar filters entries
   * by role reactively based on the live auth profile.
   */
  protected readonly NAV_SECTIONS: NavSection[] = [
    {
      headingKey: 'nav.section.main',
      items: [{ path: '/dashboard', icon: 'chart', labelKey: 'nav.dashboard' }],
    },
    {
      headingKey: 'nav.section.guild',
      items: [
        { path: '/bank', icon: 'bank', labelKey: 'nav.bank' },
        { path: '/splits', icon: 'swords', labelKey: 'nav.splits' },
        { path: '/events', icon: 'calendar', labelKey: 'nav.events' },
        { path: '/battles', icon: 'shield', labelKey: 'nav.battles' },
        { path: '/comps', icon: 'package', labelKey: 'nav.comps' },
        { path: '/siphoned', icon: 'activity', labelKey: 'nav.siphoned' },
        { path: '/users', icon: 'users', labelKey: 'nav.users' },
      ],
    },
    {
      headingKey: 'nav.section.system',
      items: [
        {
          path: '/admin',
          icon: 'hammer',
          labelKey: 'nav.admin',
          roles: ['Officer', 'Admin', 'SuperAdmin'],
        },
        { path: '/profile', icon: 'settings', labelKey: 'nav.profile' },
      ],
    },
  ];
}
