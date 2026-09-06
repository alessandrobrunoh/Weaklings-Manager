import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import type {
  AttackerStyle,
  ScenarioDeclaredCast,
  ScenarioResolvedCastLog,
  ScenarioUnitGroup,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon } from '../../../shared/components/icon/icon';
import { albionCombatIconUrl } from '../../../shared/data/albion-equipment-catalog';
import { type GroupedSpellOptions, snapSeconds, unitIdsOfGroup } from './scenario-timeline';

/** One group's units, with how many of them the selected cast currently names. */
interface TargetSection {
  readonly group: ScenarioUnitGroup;
  readonly unitIds: readonly string[];
  readonly selectedCount: number;
  /** `true`, `false` or `'mixed'` — the group toggle's `aria-checked`. */
  readonly state: 'true' | 'false' | 'mixed';
}

/**
 * The selected cast's own fields: when it goes off, what it casts, how it is measured for focus
 * fire, and exactly which unit instances it hits.
 *
 * Targets are checkboxes rather than a gesture on the timeline: a cast names unit instances, and a
 * list of labelled checkboxes with "all enemies" / "all allies" shortcuts states that directly
 * without asking anyone to aim.
 */
@Component({
  selector: 'app-timeline-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="card p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h3 class="text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('tests.timeline.inspector') }}
        </h3>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          [attr.aria-label]="t('common.close')"
          (click)="closed.emit()"
        >
          <app-icon name="close" size="0.75rem" />
        </button>
      </div>

      @if (cast(); as current) {
        <div class="grid gap-3">
          <div class="grid gap-1">
            <span class="label">{{ t('tests.timeline.casterWeapon') }}</span>
            <div class="flex items-center gap-2">
              @if (casterGroup()?.item_id; as itemId) {
                <img class="h-6 w-6 shrink-0 rounded" alt="" [src]="weaponIcon(itemId)" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs">{{ casterGroup()?.label }}</span>
                  @if (casterBuildName(); as buildName) {
                    <span class="block truncate text-[10px] text-[var(--color-text-tertiary)]">
                      {{ t('tests.timeline.fromBuild', { name: buildName }) }}
                    </span>
                  }
                </span>
              } @else {
                <span class="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">
                  {{ t('tests.timeline.noWeapon') }}
                </span>
              }
            </div>
            @if (canManage()) {
              <div class="flex flex-wrap gap-1.5">
                <button type="button" class="btn btn--outline btn--sm" (click)="buildRequested.emit()">
                  <app-icon name="search" size="0.75rem" />
                  {{ t('tests.timeline.pickBuild') }}
                </button>
                <button type="button" class="btn btn--outline btn--sm" (click)="weaponRequested.emit()">
                  {{ casterGroup()?.item_id ? t('tests.changeWeapon') : t('tests.pickWeapon') }}
                </button>
              </div>
            }
          </div>

          <label class="grid gap-1">
            <span class="label">{{ t('tests.spellId') }}</span>
            @if (spellOptions().length > 0) {
              <!--
                Selection is declared per option rather than by binding value on the select: the
                ability options are fetched, so that binding runs while the matching option does
                not exist yet, silently resolves to nothing, and is never re-applied because the
                bound id itself never changed.
              -->
              <select class="select select--sm" [disabled]="!canManage()" (change)="onSpell($event)">
                <option value="" [selected]="!current.spell_id">{{ t('tests.pickSpell') }}</option>
                @for (slot of spellOptions(); track slot.group) {
                  <optgroup [label]="slot.group">
                    @for (option of slot.options; track option.value) {
                      <option [value]="option.value" [selected]="option.value === current.spell_id">
                        {{ option.label }}
                      </option>
                    }
                  </optgroup>
                }
              </select>
            } @else {
              <p class="text-[11px] text-[var(--color-text-tertiary)]">
                {{ t('tests.timeline.pickWeaponForSpells') }}
              </p>
              <input
                class="input input--sm font-mono"
                type="text"
                placeholder="SPELL_ID"
                [value]="current.spell_id"
                [disabled]="!canManage()"
                (change)="onSpell($event)"
              />
            }
            @if (spellIsForeign()) {
              <span class="text-[11px] text-[var(--color-warning)]">
                {{ t('tests.timeline.spellNotOnWeapon') }}
              </span>
            }
          </label>

          <label class="grid gap-1">
            <span class="label">{{ t('tests.caster') }}</span>
            <select class="select select--sm" [disabled]="!canManage()" (change)="onCaster($event)">
              @for (group of groups(); track $index) {
                <option [value]="group.id" [selected]="group.id === current.caster_group_id">
                  {{ group.label }} ({{ group.id }})
                </option>
              }
            </select>
          </label>

          <label class="grid gap-1">
            <span class="label">{{ t('tests.castAt') }}</span>
            <input
              class="input input--sm"
              type="number"
              step="0.1"
              min="0"
              [value]="current.cast_at"
              [disabled]="!canManage()"
              (change)="onCastAt($event)"
            />
            @if (landAt() !== null) {
              <span class="text-[11px] text-[var(--color-text-tertiary)]">
                {{ t('tests.timeline.landAt', { at: secondsLabel(landAt()!) }) }}
              </span>
            }
          </label>

          @if (resolved(); as log) {
            <div class="grid gap-1">
              <span class="label">{{ t('tests.timeline.lastRun') }}</span>
              <span
                class="text-xs font-semibold"
                [class.text-[var(--color-error)]]="log.per_target_health_change < 0"
                [class.text-[var(--color-success)]]="log.per_target_health_change > 0"
              >
                {{ t('tests.perTargetChange') }}:
                {{ log.per_target_health_change.toFixed(1) }}
              </span>
              @if (log.per_target_health_change === 0 && log.unsupported.length > 0) {
                <p class="text-[11px] text-[var(--color-warning)]">
                  {{ t('tests.timeline.notModelled', { keys: unsupportedKeys(log.unsupported) }) }}
                </p>
              }
            </div>
          }

          <fieldset class="grid gap-1">
            <legend class="label">{{ t('tests.attackerStyle') }}</legend>
            <div class="flex flex-wrap gap-3">
              @for (style of styles; track style) {
                <label class="flex items-center gap-1.5 text-xs">
                  <input
                    type="radio"
                    name="attacker-style"
                    [value]="style"
                    [checked]="(current.attacker_style ?? 'melee') === style"
                    [disabled]="!canManage()"
                    (change)="onAttackerStyle(style)"
                  />
                  {{ t(styleKey(style)) }}
                </label>
              }
            </div>
          </fieldset>

          <div class="grid gap-1">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="label">{{ t('tests.targets') }}</span>
              <span class="text-[11px] text-[var(--color-text-tertiary)]">
                {{ t('tests.timeline.targetsCount', { count: current.target_ids.length }) }}
              </span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="!canManage()"
                (click)="selectSide('enemy')"
              >
                {{ t('tests.timeline.targetsAllEnemies') }}
              </button>
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="!canManage()"
                (click)="selectSide('ally')"
              >
                {{ t('tests.timeline.targetsAllAllies') }}
              </button>
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                [disabled]="!canManage()"
                (click)="emitTargets([])"
              >
                {{ t('tests.timeline.targetsNone') }}
              </button>
            </div>

            @for (section of targetSections(); track $index) {
              <section class="mt-2">
                <button
                  type="button"
                  role="checkbox"
                  class="group-toggle"
                  [attr.aria-checked]="section.state"
                  [disabled]="!canManage()"
                  (click)="toggleGroup(section)"
                >
                  <span class="group-toggle__box" aria-hidden="true">
                    @if (section.state === 'true') {
                      <app-icon name="check" size="0.625rem" />
                    } @else if (section.state === 'mixed') {
                      <span class="group-toggle__dash"></span>
                    }
                  </span>
                  <span class="truncate">{{ section.group.label }}</span>
                  <span class="text-[10px] text-[var(--color-text-tertiary)]">
                    {{ section.selectedCount }}/{{ section.unitIds.length }}
                  </span>
                </button>
                <ul class="unit-list" role="list">
                  @for (unitId of section.unitIds; track unitId) {
                    <li>
                      <label class="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          [checked]="current.target_ids.includes(unitId)"
                          [disabled]="!canManage()"
                          (change)="toggleUnit(unitId)"
                        />
                        <span class="font-mono">{{ unitId }}</span>
                      </label>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>

          @if (canManage()) {
            <button
              type="button"
              class="btn btn--outline btn--sm w-full"
              (click)="removed.emit(castIndex())"
            >
              <app-icon name="close" size="0.75rem" />
              {{ t('common.delete') }}
            </button>
          }
        </div>
      } @else {
        <p class="text-xs text-[var(--color-text-secondary)]">
          {{ t('tests.timeline.inspectorEmpty') }}
        </p>
      }
    </div>
  `,
  styles: `
    .group-toggle {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.375rem;
      border-radius: 4px;
      padding: 0.125rem 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text);
    }
    .group-toggle:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .group-toggle__box {
      display: inline-flex;
      height: 0.875rem;
      width: 0.875rem;
      flex: none;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--color-border-strong, var(--color-border));
      border-radius: 3px;
    }
    .group-toggle__dash {
      height: 2px;
      width: 0.5rem;
      background-color: var(--color-text);
    }
    .unit-list {
      display: grid;
      gap: 0.125rem;
      max-height: 12rem;
      overflow-y: auto;
      padding-left: 1.25rem;
    }
  `,
})
export class TimelineInspector {
  private readonly translate = inject(TranslateService);

  readonly cast = input<ScenarioDeclaredCast | null>(null);
  readonly castIndex = input.required<number>();
  readonly groups = input.required<readonly ScenarioUnitGroup[]>();
  /** The group doing the casting, so its weapon can be picked without leaving the Timeline. */
  readonly casterGroup = input<ScenarioUnitGroup | null>(null);
  /** The name behind that group's `build_id`, resolved by the page; absent until it arrives. */
  readonly casterBuildName = input<string | null>(null);
  readonly spellOptions = input<readonly GroupedSpellOptions[]>([]);
  /** Every spell id the caster's weapon offers — empty when it has no weapon. */
  readonly knownSpellIds = input<ReadonlySet<string>>(new Set<string>());
  /** When this cast landed in the last run, if the run could be matched to it. */
  readonly landAt = input<number | null>(null);
  /** How the last run resolved this cast, when it could be matched to one. */
  readonly resolved = input<ScenarioResolvedCastLog | null>(null);
  readonly canManage = input(false);

  readonly patched = output<{ index: number; patch: Partial<ScenarioDeclaredCast> }>();
  readonly removed = output<number>();
  readonly closed = output<void>();
  /** Asks the page to open its build search against the caster group. */
  readonly buildRequested = output<void>();
  /** Asks the page to open its weapon picker against the caster group. */
  readonly weaponRequested = output<void>();

  protected readonly styles: readonly AttackerStyle[] = ['melee', 'ranged', 'mounted'];

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  /** A spell the caster's weapon does not list — kept, but worth saying out loud. */
  protected readonly spellIsForeign = computed(() => {
    const current = this.cast();
    const known = this.knownSpellIds();
    if (!current || !current.spell_id || known.size === 0) return false;
    return !known.has(current.spell_id);
  });

  protected readonly targetSections = computed<TargetSection[]>(() => {
    const selected = new Set(this.cast()?.target_ids ?? []);
    return this.groups().map((group) => {
      const unitIds = unitIdsOfGroup(group);
      const selectedCount = unitIds.filter((id) => selected.has(id)).length;
      return {
        group,
        unitIds,
        selectedCount,
        state:
          selectedCount === 0
            ? ('false' as const)
            : selectedCount === unitIds.length
              ? ('true' as const)
              : ('mixed' as const),
      };
    });
  });

  /**
   * The distinct effect keys the engine reported it does not model, as a plain list.
   *
   * `unsupported` entries read `SPELL_ID:key`; the spell is already on screen, and the same key can
   * appear once per link in the chain, so only the keys are shown and only once each. This is the
   * whole answer to "it landed and did nothing": the damage of many abilities is delivered through
   * a `dash` end-effect, a `pulsingspell` or an `aura`, none of which the resolver follows.
   */
  protected unsupportedKeys(unsupported: readonly string[]): string {
    return [
      ...new Set(unsupported.map((entry) => entry.split(':')[1]?.split(' ')[0]).filter(Boolean)),
    ].join(', ');
  }

  protected weaponIcon(itemId: string): string {
    return albionCombatIconUrl(itemId);
  }

  protected styleKey(style: AttackerStyle): TranslationKey {
    return `tests.${style}` as TranslationKey;
  }

  protected secondsLabel(value: number): string {
    return this.t('tests.timeline.seconds', { value: value.toFixed(1) });
  }

  protected onSpell(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    this.patched.emit({ index: this.castIndex(), patch: { spell_id: target.value.trim() } });
  }

  protected onCaster(event: Event): void {
    this.patched.emit({
      index: this.castIndex(),
      patch: { caster_group_id: (event.target as HTMLSelectElement).value },
    });
  }

  protected onCastAt(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.patched.emit({ index: this.castIndex(), patch: { cast_at: snapSeconds(value) } });
  }

  protected onAttackerStyle(style: AttackerStyle): void {
    this.patched.emit({ index: this.castIndex(), patch: { attacker_style: style } });
  }

  protected emitTargets(targetIds: string[]): void {
    if (!this.canManage()) return;
    this.patched.emit({ index: this.castIndex(), patch: { target_ids: targetIds } });
  }

  protected selectSide(side: 'ally' | 'enemy'): void {
    this.emitTargets(
      this.groups()
        .filter((group) => group.side === side)
        .flatMap((group) => unitIdsOfGroup(group)),
    );
  }

  protected toggleGroup(section: TargetSection): void {
    const current = new Set(this.cast()?.target_ids ?? []);
    // A partial selection fills in rather than clears: the half-selected state is almost always a
    // step towards "all of them", never towards "none of them".
    if (section.state === 'true') {
      for (const id of section.unitIds) current.delete(id);
    } else {
      for (const id of section.unitIds) current.add(id);
    }
    this.emitTargets([...current]);
  }

  protected toggleUnit(unitId: string): void {
    const current = new Set(this.cast()?.target_ids ?? []);
    if (current.has(unitId)) current.delete(unitId);
    else current.add(unitId);
    this.emitTargets([...current]);
  }
}
