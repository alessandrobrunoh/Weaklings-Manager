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
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
  `,
  template: `
    <article class="kpi-card">
      <div class="flex items-start justify-between gap-2.5">
        <div class="min-w-0 flex-1">
          <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase truncate">
            {{ label() }}
          </p>
          <div class="flex items-baseline gap-2 mt-1">
            <p class="font-mono text-2xl font-bold tracking-tight" [style.color]="valueColor()">
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
            <p class="mt-1 text-xs text-[var(--color-text-secondary)] truncate">{{ sub() }}</p>
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
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      case 'warning':
        return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
      case 'danger':
        return 'bg-red-500/10 text-red-400 border border-red-500/20';
      case 'primary':
        return 'bg-sky-500/10 text-sky-400 border border-sky-500/20';
      case 'neutral':
        return 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20';
      default:
        return 'bg-sky-500/10 text-sky-400 border border-sky-500/20';
    }
  }

  protected valueColor(): string {
    switch (this.tone()) {
      case 'success':
        return '#4ade80';
      case 'warning':
        return '#facc15';
      case 'danger':
        return '#f87171';
      case 'primary':
        return '#38bdf8';
      case 'neutral':
        return 'var(--color-text)';
      default:
        return 'var(--color-text)';
    }
  }
}
