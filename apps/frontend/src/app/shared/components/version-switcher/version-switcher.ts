import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { VersionRef } from '../../../core/models/api.models';

/**
 * Switches between the versions of one build or composition.
 *
 * The group is the `(name, category)` pair, so every entry here shares a name — the version number
 * is the only thing that distinguishes them, and it carries the meaning rather than colour or
 * position. Hidden entirely when there is only one version, so a build nobody has versioned looks
 * exactly as it did before.
 *
 * @example
 * ```html
 * <app-version-switcher
 *   [versions]="build().versions ?? []"
 *   [currentId]="build().id"
 *   [canManage]="canManage()"
 *   (select)="openVersion($event)"
 *   (create)="createVersion()"
 * />
 * ```
 */
@Component({
  selector: 'app-version-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (versions().length > 1 || canManage()) {
      <div class="flex flex-wrap items-center gap-2">
        @if (versions().length > 1) {
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ label() }}</span>
          <nav class="flex flex-wrap gap-1" [attr.aria-label]="label()">
            @for (entry of versions(); track entry.id) {
              <button
                type="button"
                class="btn btn--sm"
                [class.btn--primary]="entry.id === currentId()"
                [class.btn--outline]="entry.id !== currentId()"
                [attr.aria-current]="entry.id === currentId() ? 'true' : null"
                [disabled]="busy()"
                (click)="select.emit(entry.id)"
              >
                v{{ entry.version }}
              </button>
            }
          </nav>
        }
        @if (canManage()) {
          <button type="button" class="btn btn--sm btn--tonal" [disabled]="busy()" (click)="create.emit()">
            + {{ createLabel() }}
          </button>
        }
      </div>
    }
  `,
})
export class VersionSwitcher {
  readonly versions = input.required<readonly VersionRef[]>();
  readonly currentId = input.required<number>();
  readonly canManage = input(false);
  readonly busy = input(false);
  /** Supplied by the parent so both labels stay translated. */
  readonly label = input('Version');
  readonly createLabel = input('New version');

  readonly select = output<number>();
  readonly create = output<void>();

  protected readonly hasSiblings = computed(() => this.versions().length > 1);
}
