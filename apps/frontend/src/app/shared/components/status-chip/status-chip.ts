import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon, type IconName } from '../icon/icon';

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
 * Always text plus a glyph, never colour alone: semantic tones get a default icon (check, alert,
 * info); neutral gets a dot. Colour is reserved for a real state; anything unknown reads neutral.
 *
 * @example
 * <app-status-chip value="approved" />
 */
@Component({
  selector: 'app-status-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  styles: `
    :host {
      display: inline-flex;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 1.5rem;
      padding: 0.125rem 0.5rem;
      border: 1px solid transparent;
      border-radius: var(--radius-badges);
      font-size: var(--ui-text-xs);
      font-weight: 500;
      line-height: 1rem;
      white-space: nowrap;
    }
    .status-dot {
      display: inline-block;
      width: 0.375rem;
      height: 0.375rem;
      border-radius: var(--radius-pills);
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
      background: var(--color-info-container);
      color: var(--color-info);
      border-color: color-mix(in oklab, var(--color-info) 24%, transparent);
    }
    .chip--neutral {
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      border-color: var(--color-border);
    }
  `,
  template: `
    <span class="chip" [class]="'chip--' + tone()">
      @if (glyph(); as iconName) {
        <app-icon [name]="iconName" size="0.75rem" />
      } @else if (showDot()) {
        <span class="status-dot" aria-hidden="true"></span>
      }
      {{ display() }}
    </span>
  `,
})
export class StatusChip {
  readonly value = input.required<string>();

  /** Explicit tone override for statuses this map cannot know about. */
  readonly toneOverride = input<ChipTone | undefined>(undefined);
  /** Optional translated label. Falls back to a humanized status value. */
  readonly label = input<string | undefined>(undefined);
  /** Optional icon replacing the default status dot. */
  readonly icon = input<IconName | undefined>(undefined);
  /** Whether an unmapped status should render the default dot. */
  readonly showDot = input(true);

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
    open: 'info',
    drawn: 'success',
    cancelled: 'error',
    expired_empty: 'warning',
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

  /** The glyph shown before the text: the explicit icon, else one per semantic tone. */
  protected readonly glyph = computed<IconName | null>(() => {
    const explicit = this.icon();
    if (explicit) return explicit;
    switch (this.tone()) {
      case 'success':
        return 'check';
      case 'warning':
      case 'error':
        return 'alert';
      case 'info':
        return 'info';
      default:
        return null;
    }
  });

  protected readonly display = computed(() => {
    const label = this.label();
    if (label !== undefined) return label;
    const raw = this.value();
    if (!raw) return '';
    return raw
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  });
}
