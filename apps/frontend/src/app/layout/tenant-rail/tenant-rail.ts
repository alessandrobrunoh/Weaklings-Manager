import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';

import type { TenantChoice } from '../../core/models/api.models';
import { discordGuildIconUrl } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

/**
 * Discord-style server rail: one circle per tenant the session can enter,
 * plus the "add a server" affordance pinned under a divider — the same
 * shape and behaviour as the client's own guild list (squircle-on-hover,
 * white selection pill on the left edge).
 */
@Component({
  selector: 'app-tenant-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, TooltipDirective],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      height: 100%;
      width: var(--rail-width, 72px);
      background: var(--color-rail);
    }
    .rail__list {
      scrollbar-width: none;
    }
    .rail__list::-webkit-scrollbar {
      display: none;
    }
    .rail__slot {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      padding-block: 0.25rem;
    }
    /* Selection pill on the left edge: 8px stub on hover, 40px when active. */
    .rail__pill {
      position: absolute;
      left: 0;
      width: 4px;
      height: 0;
      border-radius: 0 4px 4px 0;
      background: var(--color-text);
      transition: height 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .rail__slot:hover .rail__pill {
      height: 20px;
    }
    .rail__pill--active,
    .rail__slot:hover .rail__pill--active {
      height: 40px;
    }
    .rail__orb {
      position: relative;
      width: 48px;
      height: 48px;
      border: 0;
      padding: 0;
      border-radius: var(--radius-cards);
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-chrome);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      text-decoration: none;
      transition:
        border-radius 0.15s cubic-bezier(0.16, 1, 0.3, 1),
        background-color 0.15s ease,
        color 0.15s ease;
    }
    .rail__orb--round {
      border-radius: var(--radius-pills);
    }
    .rail__orb--round:hover,
    .rail__orb--active {
      border-radius: var(--radius-cards);
    }
    .rail__orb:hover:not(.rail__orb--active) {
      background: var(--color-primary);
      color: var(--color-on-primary);
    }
    .rail__orb--active {
      background: var(--color-primary);
      color: var(--color-on-primary);
    }
    .rail__orb--add {
      background: var(--color-chrome);
      color: var(--color-success);
    }
    .rail__orb--add:hover {
      background: var(--color-success-solid);
      color: #ffffff;
    }
    .rail__orb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .rail__divider {
      width: 32px;
      height: 2px;
      margin: 0.25rem auto;
      border-radius: 1px;
      background: var(--color-border);
    }
  `,
  template: `
    <nav
      class="flex h-full flex-col items-stretch py-3"
      [attr.aria-label]="t('nav.aria.tenants')"
    >
      <ul class="rail__list flex min-h-0 flex-1 flex-col items-stretch gap-0.5 overflow-y-auto" role="list">
        @for (tenant of tenants(); track tenant.id) {
          <li class="rail__slot">
            <span
              class="rail__pill"
              [class.rail__pill--active]="tenant.id === activeId()"
              aria-hidden="true"
            ></span>
            <button
              type="button"
              class="rail__orb rail__orb--round"
              [class.rail__orb--active]="tenant.id === activeId()"
              [attr.aria-current]="tenant.id === activeId() ? 'true' : null"
              [attr.aria-label]="tenant.name"
              [appTooltip]="tenant.name"
              tooltipPosition="right"
              [disabled]="busy()"
              (click)="select(tenant)"
            >
              @if (iconUrl(tenant); as src) {
                <img [src]="src" [alt]="" />
              } @else {
                <span>{{ initial(tenant.name) }}</span>
              }
            </button>
          </li>
        }
      </ul>

      <div class="rail__divider" role="separator"></div>

      <div class="rail__slot">
        <span class="rail__pill" [class.rail__pill--active]="isOnAddServer()" aria-hidden="true"></span>
        <a
          routerLink="/add-server"
          class="rail__orb rail__orb--round rail__orb--add"
          [appTooltip]="t('addServer.railTooltip')"
          tooltipPosition="right"
          [attr.aria-label]="t('addServer.railTooltip')"
          (click)="navigate.emit()"
        >
          <app-icon name="plus" size="1.5rem" />
        </a>
      </div>
    </nav>
  `,
})
export class TenantRail {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  /** Emits when the rail navigates — used to auto-close the mobile drawer. */
  readonly navigate = output<void>();

  protected readonly tenants = signal<TenantChoice[]>([]);
  protected readonly busy = signal(false);
  protected readonly activeId = computed(() => this.auth.profile()?.tenant_id ?? '');
  private readonly currentUrl = signal(this.router.url);
  protected readonly isOnAddServer = computed(() =>
    this.currentUrl().split('?')[0].startsWith('/add-server'),
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => this.currentUrl.set(event.urlAfterRedirects));
  }

  protected iconUrl(tenant: TenantChoice): string | null {
    return discordGuildIconUrl(tenant.id, tenant.icon_hash);
  }

  protected initial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  protected async select(tenant: TenantChoice): Promise<void> {
    if (tenant.id === this.activeId() || this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.auth.switchTenant(tenant.id);
      await this.router.navigateByUrl('/dashboard');
      this.navigate.emit();
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      this.tenants.set(await this.auth.myTenants());
    } catch {
      this.tenants.set([]);
    }
  }
}
