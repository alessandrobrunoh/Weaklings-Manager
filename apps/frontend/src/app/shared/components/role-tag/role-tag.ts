import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import type { BuildRole } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';

/** Every build role, in the order a composition lists them (front line first). */
export const BUILD_ROLES: readonly BuildRole[] = [
  'tank',
  'healer',
  'support',
  'brawler',
  'dps',
  'battle_mount',
];

const ROLE_LABEL_KEYS: Readonly<Record<BuildRole, TranslationKey>> = {
  tank: 'role.tank',
  healer: 'role.healer',
  support: 'role.support',
  brawler: 'role.brawler',
  dps: 'role.dps',
  battle_mount: 'role.battle_mount',
};

const ROLE_GLYPHS: Readonly<Record<BuildRole, string>> = {
  tank: 'T',
  healer: 'H',
  support: 'S',
  brawler: 'B',
  dps: 'D',
  battle_mount: 'BM',
};

/** Translation key of a role's player-facing name, for text outside the tag (menus, summaries). */
export function roleLabelKey(role: BuildRole): TranslationKey {
  return ROLE_LABEL_KEYS[role] ?? 'role.dps';
}

/** The one- or two-letter mark shown inside a {@link RoleTag}. */
export function roleGlyph(role: BuildRole): string {
  return ROLE_GLYPHS[role] ?? '?';
}

/**
 * The one way to show a build role.
 *
 * Neutral on purpose: role is identity, not state, so it never borrows the success/warning/error
 * hues that mean win, caution and loss elsewhere. The glyph plus the localized label carry the
 * meaning, in both themes, at one size (12px) so lists stay aligned.
 *
 * @example
 * ```html
 * <app-role-tag [role]="build.role" />
 * ```
 */
@Component({
  selector: 'app-role-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
      vertical-align: middle;
    }
    .role-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 1.375rem;
      padding: 0 0.5rem 0 0.1875rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1rem;
      white-space: nowrap;
    }
    .role-tag__glyph {
      display: inline-grid;
      place-items: center;
      min-width: 1.125rem;
      height: 1.125rem;
      padding: 0 0.125rem;
      border-radius: var(--radius-sm);
      background: var(--color-surface-3);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1;
    }
  `,
  template: `
    <span class="role-tag">
      <span class="role-tag__glyph" aria-hidden="true">{{ glyph() }}</span>
      <span>{{ label() }}</span>
    </span>
  `,
})
export class RoleTag {
  private readonly translate = inject(TranslateService);

  /** The build role to show. */
  readonly role = input.required<BuildRole>();

  protected readonly glyph = computed(() => roleGlyph(this.role()));
  protected readonly label = computed(() => this.translate.t(roleLabelKey(this.role())));
}
