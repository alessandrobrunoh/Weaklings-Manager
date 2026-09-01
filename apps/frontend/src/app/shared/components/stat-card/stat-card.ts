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
  template: `
    <div class="card p-3 flex flex-col justify-between h-full">
      <div class="flex items-center justify-between gap-2 mb-3">
        <p class="eyebrow truncate">{{ label() }}</p>
        @if (icon()) {
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
            style="background-color: var(--color-surface-2); color: var(--color-text-secondary)"
            aria-hidden="true"
          >
            <app-icon [name]="icon()!" size="0.875rem" />
          </span>
        }
      </div>
      <div>
        <div class="flex items-baseline justify-between gap-2">
          <p class="mono text-xl font-normal leading-tight tracking-[-0.02em]" [style.color]="valueColor()">
            {{ value() !== null && value() !== undefined ? value() : '—' }}
          </p>
          @if (delta()) {
            <span
              class="chip text-[10px] font-mono font-bold"
              [class.chip--success]="deltaDirection() === 'up'"
              [class.chip--error]="deltaDirection() === 'down'"
              [class.chip--neutral]="deltaDirection() === 'neutral'"
            >
              {{ delta() }}
            </span>
          }
        </div>
        @if (sub()) {
          <p class="mt-1 text-[11px]" style="color: var(--color-text-tertiary)">{{ sub() }}</p>
        }
      </div>
    </div>
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
      default:
        return 'var(--color-text)';
    }
  }
}
