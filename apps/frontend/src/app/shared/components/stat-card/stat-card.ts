import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, type IconName } from '../icon/icon';

/**
 * KPI tile: quiet 12px label, optional icon and mono figure. Kept for pages not yet migrated;
 * new work uses `app-summary-band` + `app-stat` (a compact strip instead of a grid of cards).
 */
@Component({
  selector: 'app-stat-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  styles: `
    :host {
      display: block;
      height: 100%;
    }
    .kpi-card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 100%;
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-smallcards);
      background: var(--color-surface);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.75rem;
      height: 1.75rem;
      flex-shrink: 0;
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .icon-capsule--success { color: var(--color-success); }
    .icon-capsule--warning { color: var(--color-warning); }
    .icon-capsule--danger { color: var(--color-error); }
    .icon-capsule--primary { color: var(--color-primary); }
  `,
  template: `
    <article class="kpi-card">
      <div class="flex items-start justify-between gap-2.5">
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-semibold text-[var(--color-text-secondary)]">{{ label() }}</p>
          <div class="mt-0.5 flex items-baseline gap-2">
            <p class="font-mono text-xl font-semibold tracking-tight" [style.color]="valueColor()">
              {{ value() !== null && value() !== undefined ? value() : '—' }}
            </p>
            @if (delta()) {
              <span
                class="chip font-mono"
                [class.chip--success]="deltaDirection() === 'up'"
                [class.chip--error]="deltaDirection() === 'down'"
                [class.chip--neutral]="deltaDirection() === 'neutral'"
              >
                {{ deltaDirection() === 'up' ? '▲ ' : deltaDirection() === 'down' ? '▼ ' : '' }}{{ delta() }}
              </span>
            }
          </div>
          @if (sub()) {
            <p class="mt-0.5 truncate text-xs text-[var(--color-text-secondary)]">{{ sub() }}</p>
          }
        </div>
        @if (icon()) {
          <div class="icon-capsule" [class]="iconCapsuleClass()">
            <app-icon [name]="icon()!" size="1rem" />
          </div>
        }
      </div>
    </article>
  `,
})
export class StatCard {
  readonly label = input.required<string>();
  readonly value = input.required<string | number | null>();
  readonly sub = input<string>();
  readonly icon = input<IconName | undefined>(undefined);
  readonly tone = input<'default' | 'neutral' | 'success' | 'warning' | 'danger' | 'primary'>('default');
  readonly delta = input<string | undefined>(undefined);
  readonly deltaDirection = input<'up' | 'down' | 'neutral'>('neutral');

  protected iconCapsuleClass(): string {
    switch (this.tone()) {
      case 'success':
        return 'icon-capsule--success';
      case 'warning':
        return 'icon-capsule--warning';
      case 'danger':
        return 'icon-capsule--danger';
      case 'primary':
        return 'icon-capsule--primary';
      case 'neutral':
        return 'icon-capsule--neutral';
      default:
        return '';
    }
  }

  protected valueColor(): string {
    switch (this.tone()) {
      case 'success':
        return 'var(--color-success)';
      case 'warning':
        return 'var(--color-warning)';
      case 'danger':
        return 'var(--color-error)';
      case 'primary':
        return 'var(--color-primary)';
      case 'neutral':
        return 'var(--color-text)';
      default:
        return 'var(--color-text)';
    }
  }
}
