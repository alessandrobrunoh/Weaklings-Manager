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
