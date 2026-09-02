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
      background: rgba(74, 222, 128, 0.12);
      color: #4ade80;
      border-color: rgba(74, 222, 128, 0.25);
    }
    .chip--warning {
      background: rgba(250, 204, 21, 0.12);
      color: #facc15;
      border-color: rgba(250, 204, 21, 0.25);
    }
    .chip--error {
      background: rgba(248, 113, 113, 0.12);
      color: #f87171;
      border-color: rgba(248, 113, 113, 0.25);
    }
    .chip--info {
      background: rgba(56, 189, 248, 0.12);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.25);
    }
    .chip--neutral {
      background: rgba(148, 163, 184, 0.1);
      color: #94a3b8;
      border-color: rgba(148, 163, 184, 0.2);
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
