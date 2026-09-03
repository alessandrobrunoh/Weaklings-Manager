import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, type IconName } from '../icon/icon';

/**
 * Modular KPI tile: quiet eyebrow label, optional icon, and mono figure.
 * Reusable across Dashboard, Battles, Events, Bank, Compositions, etc.
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
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-xl, 12px);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: var(--spacing-16, 1rem) var(--spacing-20, 1.25rem);
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-strong);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: var(--radius-md, 6px);
      flex-shrink: 0;
      border: 1px solid transparent;
    }
    .icon-capsule--success { background: var(--color-success-container); color: var(--color-success); border-color: color-mix(in oklab, var(--color-success) 24%, transparent); }
    .icon-capsule--warning { background: var(--color-warning-container); color: var(--color-warning); border-color: color-mix(in oklab, var(--color-warning) 24%, transparent); }
    .icon-capsule--danger { background: var(--color-error-container); color: var(--color-error); border-color: color-mix(in oklab, var(--color-error) 24%, transparent); }
    .icon-capsule--primary { background: var(--color-primary-container); color: var(--color-primary-hover); border-color: color-mix(in oklab, var(--color-primary) 24%, transparent); }
    .icon-capsule--neutral { background: var(--color-surface-2); color: var(--color-text-secondary); border-color: var(--color-border); }
  `,
  template: `
    <article class="kpi-card">
      <div class="flex items-start justify-between gap-2.5">
        <div class="min-w-0 flex-1">
          <p class="text-[var(--text-caption)] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase truncate">
            {{ label() }}
          </p>
          <div class="flex items-baseline gap-2 mt-1">
            <p class="font-mono text-2xl font-medium tracking-tight" [style.color]="valueColor()">
              {{ value() !== null && value() !== undefined ? value() : '—' }}
            </p>
            @if (delta()) {
              <span
                class="chip text-[10px] font-mono font-medium"
                [class.chip--success]="deltaDirection() === 'up'"
                [class.chip--error]="deltaDirection() === 'down'"
                [class.chip--neutral]="deltaDirection() === 'neutral'"
              >
                {{ delta() }}
              </span>
            }
          </div>
          @if (sub()) {
            <p class="mt-1 text-xs text-[var(--color-text-tertiary)] truncate">{{ sub() }}</p>
          }
        </div>
        @if (icon()) {
          <div class="icon-capsule" [class]="iconCapsuleClass()">
            <app-icon [name]="icon()!" size="1.125rem" />
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
        return 'icon-capsule--primary';
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
        return 'var(--color-primary-hover)';
      case 'neutral':
        return 'var(--color-text)';
      default:
        return 'var(--color-text)';
    }
  }
}
