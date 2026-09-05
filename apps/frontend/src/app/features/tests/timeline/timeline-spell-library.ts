import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import type { ScenarioUnitGroup } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { albionAbilityIconUrl } from '../../../shared/data/albion-abilities';
import { parseCooldownSeconds } from './scenario-timeline';

/** What a library entry carries onto a lane. */
export interface LibraryDragPayload {
  readonly kind: 'spell';
  readonly casterGroupId: string;
  readonly spellId: string;
}

/** One draggable ability, already resolved against its group's weapon. */
interface LibraryEntry {
  readonly spellId: string;
  readonly name: string;
  readonly slotLabel: string;
  readonly cooldownSeconds: number | null;
}

interface LibrarySection {
  readonly group: ScenarioUnitGroup;
  readonly entries: readonly LibraryEntry[];
}

/**
 * The spells each group's weapon can cast, as things to drag onto the timeline.
 *
 * Every entry is both `draggable` and a real `<button>`: the drag is the fast path, and activating
 * the button is the equivalent that works from the keyboard — without it the editor would have a
 * gesture with no non-pointer counterpart.
 */
@Component({
  selector: 'app-timeline-spell-library',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card p-3">
      <h3 class="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
        {{ t('tests.timeline.library') }}
      </h3>

      @if (sections().length === 0) {
        <p class="text-xs text-[var(--color-text-secondary)]">
          {{ t('tests.timeline.libraryEmpty') }}
        </p>
      } @else {
        <p class="mb-3 text-[11px] text-[var(--color-text-tertiary)]">
          {{ t('tests.timeline.libraryHint') }}
        </p>
        <div class="grid gap-3">
          @for (section of sections(); track $index) {
            <section>
              <h4 class="mb-1 truncate text-xs font-semibold text-[var(--color-text)]">
                {{ section.group.label }}
              </h4>
              <ul class="grid gap-1" role="list">
                @for (entry of section.entries; track entry.spellId) {
                  <li>
                    <button
                      type="button"
                      class="library-entry"
                      [attr.draggable]="canManage()"
                      [disabled]="!canManage()"
                      [attr.aria-label]="entry.name + ' — ' + entry.slotLabel"
                      (dragstart)="onDragStart($event, section.group.id, entry.spellId)"
                      (dragend)="dragEnded.emit()"
                      (click)="addRequested.emit({ casterGroupId: section.group.id, spellId: entry.spellId })"
                    >
                      <span class="library-slot" aria-hidden="true">{{ entry.slotLabel }}</span>
                      <img
                        class="h-6 w-6 shrink-0 rounded"
                        alt=""
                        [src]="iconFor(entry.spellId)"
                        (error)="onIconError($event)"
                      />
                      <span class="min-w-0 flex-1 truncate text-left">{{ entry.name }}</span>
                      @if (entry.cooldownSeconds !== null) {
                        <span class="library-cooldown">{{ entry.cooldownSeconds }}s</span>
                      }
                    </button>
                  </li>
                }
              </ul>
            </section>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .library-entry {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.5rem;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background-color: var(--color-surface-2, var(--color-surface));
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      color: var(--color-text);
      cursor: grab;
    }
    .library-entry:hover:not(:disabled) {
      border-color: var(--color-primary);
    }
    .library-entry:disabled {
      cursor: default;
      opacity: 0.6;
    }
    .library-entry:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .library-slot {
      min-width: 1.25rem;
      border-radius: 4px;
      background-color: var(--color-primary-container);
      padding: 0 0.25rem;
      text-align: center;
      font-size: 0.625rem;
      font-weight: 700;
    }
    .library-cooldown {
      font-variant-numeric: tabular-nums;
      font-size: 0.625rem;
      color: var(--color-text-tertiary);
    }
  `,
})
export class TimelineSpellLibrary {
  private readonly translate = inject(TranslateService);

  readonly groups = input.required<readonly ScenarioUnitGroup[]>();
  /** The ability slots of each group's weapon, keyed by group id. */
  readonly slotsByGroup = input<
    Record<
      string,
      readonly {
        readonly label: string;
        readonly choices: readonly { id: string; name: string; cooldown?: string | null }[];
      }[]
    >
  >({});
  readonly canManage = input(false);

  readonly addRequested = output<{ casterGroupId: string; spellId: string }>();
  readonly dragStarted = output<LibraryDragPayload>();
  readonly dragEnded = output<void>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly sections = computed<LibrarySection[]>(() => {
    const slots = this.slotsByGroup();
    return this.groups()
      .map((group) => ({
        group,
        entries: (slots[group.id] ?? []).flatMap((slot) =>
          slot.choices.map((choice) => ({
            spellId: choice.id,
            name: choice.name,
            slotLabel: slot.label,
            cooldownSeconds: parseCooldownSeconds(choice.cooldown),
          })),
        ),
      }))
      .filter((section) => section.entries.length > 0);
  });

  protected iconFor(spellId: string): string {
    return albionAbilityIconUrl(spellId);
  }

  /** Albion's CDN has no icon for every id; hide the broken image rather than show its alt box. */
  protected onIconError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  protected onDragStart(event: DragEvent, casterGroupId: string, spellId: string): void {
    if (!this.canManage()) return;
    const payload: LibraryDragPayload = { kind: 'spell', casterGroupId, spellId };
    // The payload is unreadable during `dragover` in Chrome, so the editor also learns about the
    // drag through `dragStarted` — `dataTransfer` is what survives a drop onto another window.
    event.dataTransfer?.setData('text/plain', JSON.stringify(payload));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.dragStarted.emit(payload);
  }
}
