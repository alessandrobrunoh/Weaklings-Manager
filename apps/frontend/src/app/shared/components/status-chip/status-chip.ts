import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Chip tones the design system defines. */
type ChipTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/**
 * Maps a domain status string to a chip.
 *
 * Statuses arrive from the backend as snake_case strings across several
 * modules, so the mapping lives here rather than being restated at each call
 * site. Anything unmapped falls back to the neutral tone, which is the honest
 * outcome for a status this table has never seen.
 *
 * @example
 * <app-status-chip value="approved" />
 */
@Component({
  selector: 'app-status-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 1.375rem;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .status-dot {
      display: inline-block;
      width: 0.375rem;
      height: 0.375rem;
      border-radius: 9999px;
      background-color: currentColor;
      flex-shrink: 0;
    }
    .chip--success {
      background: var(--color-success-container);
      color: var(--color-success);
      border-color: color-mix(in oklab, var(--color-success) 24%, transparent);
    }
    .chip--warning {
      background: var(--color-warning-container);
      color: var(--color-warning);
      border-color: color-mix(in oklab, var(--color-warning) 24%, transparent);
    }
    .chip--error {
      background: var(--color-error-container);
      color: var(--color-error);
      border-color: color-mix(in oklab, var(--color-error) 24%, transparent);
    }
    .chip--info {
      background: var(--color-primary-container);
      color: var(--color-info);
      border-color: color-mix(in oklab, var(--color-info) 24%, transparent);
    }
    .chip--neutral {
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      border-color: var(--color-border);
    }
  `,
  template: `<span class="chip" [class]="'chip--' + tone()"><span class="status-dot"></span>{{ display() }}</span>`,
})
export class StatusChip {
  readonly value = input.required<string>();

  /** Explicit tone override for statuses this map cannot know about. */
  readonly toneOverride = input<ChipTone | undefined>(undefined);

  private static readonly TONES: Readonly<Record<string, ChipTone>> = {
    // Bank / splits
    pending: 'warning',
    requested: 'warning',
    withdrawn: 'success',
    donated: 'success',
    completed: 'success',
    rejected: 'error',
    not_completed: 'neutral',
    lost: 'error',
    // Regear
    available: 'info',
    approved: 'success',
    // Events
    scheduled: 'info',
    live: 'success',
    stopped: 'neutral',
    auto_stopped: 'neutral',
    // Intel brackets
    gank: 'warning',
    small_scale: 'info',
    zvz: 'error',
    // Roles
    Officer: 'info',
    Admin: 'warning',
    SuperAdmin: 'error',
    User: 'neutral',
  };

  protected readonly tone = computed<ChipTone>(
    () => this.toneOverride() ?? StatusChip.TONES[this.value()] ?? 'neutral',
  );

  protected readonly display = computed(() => {
    const raw = this.value();
    if (!raw) return '';
    return raw
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  });
}
