import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import type {
  AttackerStyle,
  ScenarioDeclaredCast,
  ScenarioDefinition,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon } from '../../../shared/components/icon/icon';
import type { GroupedSpellOptions } from './scenario-timeline';

/** One group's unit instances, ready to render as an `optgroup` of targets. */
export interface UnitOptionGroup {
  readonly groupLabel: string;
  readonly ids: readonly string[];
}

/**
 * The cast timeline as a table: one row per cast, every field a native control.
 *
 * The visual timeline is the default view, but this stays the exact alternative for editing many
 * casts at once and for anyone driving the page from the keyboard or a screen reader — a table of
 * labelled inputs needs no drag gesture and no spatial reasoning to operate.
 *
 * Presentational: it never mutates the definition, it emits the patch it would like applied.
 */
@Component({
  selector: 'app-cast-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="overflow-x-auto">
      <table class="table">
        <thead>
          <tr>
            <th class="text-left">{{ t('tests.caster') }}</th>
            <th class="text-left">{{ t('tests.spellId') }}</th>
            <th class="text-right">{{ t('tests.castAt') }}</th>
            <th class="text-left">{{ t('tests.targets') }}</th>
            <th class="text-left">{{ t('tests.attackerStyle') }}</th>
            <th class="text-center">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (cast of definition().casts; track $index; let i = $index) {
            <tr [class.row--selected]="i === selectedIndex()" (focusin)="selected.emit(i)">
              <td>
                <select
                  class="select select--sm"
                  [value]="cast.caster_group_id"
                  [disabled]="!canManage()"
                  (change)="onCaster(i, $event)"
                >
                  @for (group of definition().groups; track $index) {
                    <option [value]="group.id">{{ group.label }} ({{ group.id }})</option>
                  }
                </select>
              </td>
              <td>
                @if (spellOptionsFor(cast.caster_group_id).length > 0) {
                  <select
                    class="select select--sm"
                    [value]="cast.spell_id"
                    [disabled]="!canManage()"
                    (change)="onSpell(i, $event)"
                  >
                    <option value="">{{ t('tests.pickSpell') }}</option>
                    @for (slot of spellOptionsFor(cast.caster_group_id); track slot.group) {
                      <optgroup [label]="slot.group">
                        @for (option of slot.options; track option.value) {
                          <option [value]="option.value">{{ option.label }}</option>
                        }
                      </optgroup>
                    }
                  </select>
                } @else {
                  <input
                    class="input input--sm font-mono"
                    type="text"
                    placeholder="SPELL_ID"
                    [value]="cast.spell_id"
                    [disabled]="!canManage()"
                    (change)="onSpell(i, $event)"
                  />
                }
              </td>
              <td class="text-right">
                <input
                  class="input input--sm text-right"
                  type="number"
                  step="0.1"
                  min="0"
                  [value]="cast.cast_at"
                  [disabled]="!canManage()"
                  (change)="onCastAt(i, $event)"
                />
              </td>
              <td>
                <select
                  multiple
                  class="select select--sm"
                  style="min-height: 4.5rem"
                  [disabled]="!canManage()"
                  (change)="onTargets(i, $event)"
                >
                  @for (unitGroup of unitOptions(); track $index) {
                    <optgroup [label]="unitGroup.groupLabel">
                      @for (id of unitGroup.ids; track id) {
                        <option [value]="id" [selected]="cast.target_ids.includes(id)">
                          {{ id }}
                        </option>
                      }
                    </optgroup>
                  }
                </select>
              </td>
              <td>
                <select
                  class="select select--sm"
                  [value]="cast.attacker_style ?? 'melee'"
                  [disabled]="!canManage()"
                  (change)="onAttackerStyle(i, $event)"
                >
                  <option value="melee">{{ t('tests.melee') }}</option>
                  <option value="ranged">{{ t('tests.ranged') }}</option>
                  <option value="mounted">{{ t('tests.mounted') }}</option>
                </select>
              </td>
              <td class="text-center">
                @if (canManage()) {
                  <button type="button" class="btn btn--ghost btn--sm" (click)="removed.emit(i)">
                    <app-icon name="close" size="0.75rem" />
                  </button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .row--selected > td {
      background-color: var(--color-primary-container);
    }
  `,
})
export class CastTable {
  private readonly translate = inject(TranslateService);

  readonly definition = input.required<ScenarioDefinition>();
  /** `group id -> its weapon's abilities, grouped by slot`. Empty for a group with no weapon. */
  readonly spellOptionsByGroup = input<Record<string, GroupedSpellOptions[]>>({});
  readonly unitOptions = input<readonly UnitOptionGroup[]>([]);
  readonly canManage = input(false);
  readonly selectedIndex = input<number | null>(null);

  readonly patched = output<{ index: number; patch: Partial<ScenarioDeclaredCast> }>();
  readonly removed = output<number>();
  readonly selected = output<number>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected spellOptionsFor(groupId: string): readonly GroupedSpellOptions[] {
    return this.spellOptionsByGroup()[groupId] ?? [];
  }

  protected onCaster(index: number, event: Event): void {
    this.patched.emit({
      index,
      patch: { caster_group_id: (event.target as HTMLSelectElement).value },
    });
  }

  protected onSpell(index: number, event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    this.patched.emit({ index, patch: { spell_id: target.value.trim() } });
  }

  protected onCastAt(index: number, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.patched.emit({ index, patch: { cast_at: Math.max(0, value || 0) } });
  }

  protected onTargets(index: number, event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.patched.emit({
      index,
      patch: { target_ids: Array.from(select.selectedOptions).map((option) => option.value) },
    });
  }

  protected onAttackerStyle(index: number, event: Event): void {
    this.patched.emit({
      index,
      patch: { attacker_style: (event.target as HTMLSelectElement).value as AttackerStyle },
    });
  }
}
