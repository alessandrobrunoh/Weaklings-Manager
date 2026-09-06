import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import type { TenantChoice } from '../../core/models/api.models';
import { discordGuildIconUrl } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

/**
 * Discord-style server rail: one circle per tenant the session can enter.
 */
@Component({
  selector: 'app-tenant-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TooltipDirective],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 72px;
      background: var(--color-surface);
      border-right: 1px solid var(--color-border);
    }
    .tenant-pill {
      width: 12px;
      height: 8px;
      border-radius: 0 4px 4px 0;
      background: transparent;
      transition: height 0.12s ease, background 0.12s ease;
    }
    .tenant-pill--active {
      height: 40px;
      background: var(--color-text);
    }
    .tenant-orb {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-surface-2);
      color: var(--color-text);
      font-weight: 700;
      font-size: 1rem;
      border: 0;
      cursor: pointer;
      transition: border-radius 0.15s ease;
    }
    .tenant-orb:hover,
    .tenant-orb--active {
      border-radius: 16px;
    }
    .tenant-orb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  template: `
    <nav class="flex h-full flex-col items-center py-3 gap-1" [attr.aria-label]="t('nav.aria.tenants')">
      <ul class="flex flex-col items-stretch gap-1 w-full" role="list">
        @for (tenant of tenants(); track tenant.id) {
          <li class="flex items-center gap-0">
            <span
              class="tenant-pill"
              [class.tenant-pill--active]="tenant.id === activeId()"
              aria-hidden="true"
            ></span>
            <button
              type="button"
              class="tenant-orb"
              [class.tenant-orb--active]="tenant.id === activeId()"
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
    </nav>
  `,
})
export class TenantRail {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly tenants = signal<TenantChoice[]>([]);
  protected readonly busy = signal(false);
  protected readonly activeId = computed(() => this.auth.profile()?.tenant_id ?? '');

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
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
