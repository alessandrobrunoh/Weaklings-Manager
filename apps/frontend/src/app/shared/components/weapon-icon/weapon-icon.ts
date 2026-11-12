import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { albionCombatIconUrl } from '../../data/albion-equipment-catalog';

/**
 * A build's weapon as a small square icon tile.
 *
 * Takes the `weapon_key` a build summary already carries (`weapon:MAIN_SWORD`), so a list can show
 * weapon icons without fetching each build's detail. Albion's render CDN 404s for some weapons;
 * the tile then shows `fallback` (for example the role glyph) instead of a broken image.
 *
 * Decorative by default (`alt=""`): the build name beside it names the build.
 *
 * @example
 * ```html
 * <app-weapon-icon [weaponKey]="build.weapon_key" fallback="H" />
 * ```
 */
@Component({
  selector: 'app-weapon-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.weapon-icon--sm]': "size() === 'sm'",
  },
  styles: `
    :host {
      display: inline-grid;
      flex: 0 0 auto;
      place-items: center;
      width: 2.25rem;
      height: 2.25rem;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 600;
    }
    :host(.weapon-icon--sm) {
      width: 1.75rem;
      height: 1.75rem;
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `,
  template: `
    @if (url(); as src) {
      <img [src]="src" [alt]="alt()" loading="lazy" (error)="failed.set(src)" />
    } @else {
      <span [attr.aria-hidden]="alt() ? null : 'true'">{{ fallback() }}</span>
    }
  `,
})
export class WeaponIcon {
  /** `weapon:{BASE}` as on `BuildSummary.weapon_key`; `null` when the build has no weapon. */
  readonly weaponKey = input<string | null | undefined>(undefined);
  /** `md` (36px, default) or `sm` (28px). */
  readonly size = input<'sm' | 'md'>('md');
  /** Text shown when there is no weapon or its image fails to load. */
  readonly fallback = input('');
  /** Accessible name; leave empty when the text next to the icon already names it. */
  readonly alt = input('');

  /** The URL that last failed to load, so a changed weapon gets a fresh attempt. */
  protected readonly failed = signal<string | null>(null);

  protected readonly url = computed(() => {
    const key = this.weaponKey();
    if (!key) {
      return null;
    }
    const src = albionCombatIconUrl(key.replace(/^weapon:/, ''));
    return this.failed() === src ? null : src;
  });
}
