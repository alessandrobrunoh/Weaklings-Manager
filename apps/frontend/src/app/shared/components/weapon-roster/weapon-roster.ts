import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  OpenAlbionItem,
  UserWeapon,
  WeaponProficiency,
} from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import {
  weaponFamilyLabelKey,
  weaponFamilyOrder,
  type WeaponFamilyId,
} from '../../data/albion-weapon-families';
import { albionCombatIconUrl } from '../../data/albion-equipment-catalog';
import {
  buildWeaponEntries,
  countWeaponDraftChanges,
  draftsFromWeapons,
  filterWeaponEntries,
  groupWeaponEntries,
  manageUserWeaponsRequest,
  sortWeaponDrafts,
  summarizeWeaponDrafts,
  updateMyWeaponsRequest,
  weaponFiltersActive,
  weaponOptionsFromCatalog,
  type WeaponDraft,
  type WeaponEntry,
  type WeaponLevelFilter,
} from '../../data/user-weapons';
import { AlbionCatalogService } from '../../services/albion-catalog.service';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { Icon } from '../icon/icon';
import { Loading } from '../loading/loading';

const PROFICIENCY_LABEL: Readonly<Record<WeaponProficiency, TranslationKey>> = {
  main: 'weapons.proficiency.main',
  good: 'weapons.proficiency.good',
  basic: 'weapons.proficiency.basic',
};

/** Same tones the event bench uses for these levels, so a level reads the same everywhere. */
const PROFICIENCY_TONE: Readonly<Record<WeaponProficiency, 'success' | 'info' | 'neutral'>> = {
  main: 'success',
  good: 'info',
  basic: 'neutral',
};

/** One choice of a weapon's rating control, weakest first; `none` clears the declaration. */
interface LevelChoice {
  readonly id: 'none' | WeaponProficiency;
  readonly level: WeaponProficiency | null;
  readonly label: TranslationKey;
}

const LEVEL_CHOICES: readonly LevelChoice[] = [
  { id: 'none', level: null, label: 'weapons.proficiency.none' },
  { id: 'basic', level: 'basic', label: 'weapons.proficiency.basic' },
  { id: 'good', level: 'good', label: 'weapons.proficiency.good' },
  { id: 'main', level: 'main', label: 'weapons.proficiency.main' },
];

/** Level filter choices, in the order the select lists them. */
const LEVEL_FILTERS: readonly { id: WeaponLevelFilter; label: TranslationKey }[] = [
  { id: 'all', label: 'weapons.filter.levelAll' },
  { id: 'declared', label: 'weapons.filter.levelDeclared' },
  { id: 'main', label: 'weapons.proficiency.main' },
  { id: 'good', label: 'weapons.proficiency.good' },
  { id: 'basic', label: 'weapons.proficiency.basic' },
  { id: 'undeclared', label: 'weapons.notDeclared' },
];

let nextRosterId = 0;

/**
 * "My weapons": every weapon of the catalog at once, grouped by family, each with an inline
 * None / Basic / Good / Main rating the member sets with one click. A filter bar (name search,
 * family, level, "declared only") narrows the grid client-side.
 *
 * Only declared or locked weapons are stored; the catalog supplies the rest. The API replaces the
 * whole list, so edits are drafts saved together from a sticky bar that counts unsaved changes
 * (there is no per-weapon endpoint). Weapons are alphabetical inside a family, so changing a level
 * never moves a row. `self` mode edits the signed-in member's list. `manage` mode is the officer
 * view of another member: it adds a per-weapon lock and is read-only unless `editable` is set.
 */
@Component({
  selector: 'app-weapon-roster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, Icon, Loading],
  styles: `
    .wr__header {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem 1rem;
      margin-bottom: 1rem;
    }
    .wr__titles {
      flex: 1 1 18rem;
      min-width: 0;
    }
    .wr__title {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      color: var(--color-text);
    }
    .wr__subtitle {
      margin: 0.25rem 0 0;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .wr__summary {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .wr__summary strong {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--color-text-heading);
    }

    .wr__hint {
      display: flex;
      align-items: flex-start;
      gap: 0.375rem;
      margin: 0 0 0.75rem;
      font-size: 0.75rem;
      line-height: 1.4;
      color: var(--color-text-secondary);
    }
    .wr__hint app-icon {
      flex: none;
      margin-top: 0.0625rem;
    }

    .wr__filters {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto;
      align-items: end;
      gap: 0.5rem 0.75rem;
      margin-bottom: 0.5rem;
    }
    .wr__field {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 0.25rem;
    }
    .wr__field-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .wr__search {
      position: relative;
    }
    .wr__search app-icon {
      position: absolute;
      inset-block-start: 50%;
      inset-inline-start: 0.625rem;
      transform: translateY(-50%);
      color: var(--color-text-secondary);
      pointer-events: none;
    }
    .wr__search .input {
      padding-inline-start: 2rem;
    }
    .wr__toggle {
      justify-content: center;
      white-space: nowrap;
    }
    .wr__toggle[aria-pressed='true'] {
      border-color: var(--color-primary);
      background: var(--color-surface-2);
      color: var(--color-text-heading);
      font-weight: 700;
    }

    .wr__toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.5rem;
      margin-bottom: 0.75rem;
    }
    .wr__count {
      margin-inline-end: auto;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    .wr__empty {
      border: 1px dashed var(--color-border-strong);
      border-radius: var(--radius-md);
    }

    .wr__groups {
      display: grid;
      gap: 1rem;
    }
    .wr__group {
      container-type: inline-size;
    }
    .wr__group-title {
      margin: 0 0 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .wr__group-toggle {
      display: flex;
      width: 100%;
      min-height: 2rem;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.375rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      font: inherit;
      letter-spacing: inherit;
      text-align: start;
      text-transform: inherit;
      color: inherit;
      cursor: pointer;
    }
    .wr__group-toggle:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .wr__group-toggle:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .wr__group-count {
      min-width: 1.25rem;
      padding: 0 0.375rem;
      border-radius: var(--radius-pills);
      background: var(--color-surface-2);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      text-align: center;
      letter-spacing: 0;
      color: var(--color-text-secondary);
    }
    .wr__list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 1fr));
      gap: 0.375rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .wr__row {
      display: flex;
      align-items: center;
      gap: 0.5rem 0.625rem;
      min-width: 0;
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--color-border);
      border-inline-start: 3px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .wr__row--on {
      border-color: var(--color-border-strong);
      border-inline-start-color: var(--color-text-secondary);
      background: var(--color-surface-muted);
    }
    .wr__row--locked {
      border-style: dashed;
      border-inline-start-style: solid;
      border-inline-start-color: var(--color-border-strong);
      background: var(--color-surface-muted);
    }

    .wr__tile {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .wr__icon {
      width: 1.875rem;
      height: 1.875rem;
      object-fit: contain;
    }
    .wr__who {
      display: flex;
      flex: 1 1 0;
      min-width: 5rem;
      flex-direction: column;
      gap: 0.125rem;
    }
    .wr__name {
      overflow-wrap: anywhere;
      font-size: 0.8125rem;
      font-weight: 500;
      line-height: 1.25;
      color: var(--color-text);
    }
    .wr__row--on .wr__name {
      font-weight: 700;
      color: var(--color-text-heading);
    }
    .wr__state {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    .wr__levels {
      display: inline-grid;
      grid-auto-flow: column;
      flex: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: var(--color-surface);
    }
    .wr__level {
      position: relative;
      display: inline-flex;
      min-height: 2rem;
      min-width: 3.75rem;
      align-items: center;
      justify-content: center;
      gap: 0.25rem;
      padding: 0.25rem 0.5rem;
      border-inline-start: 1px solid var(--color-border);
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-text-secondary);
      cursor: pointer;
      user-select: none;
    }
    .wr__level:first-of-type {
      border-inline-start: 0;
    }
    .wr__level:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .wr__level--none {
      --wr-tone: var(--color-border-strong);
      --wr-tone-bg: transparent;
    }
    .wr__level--main {
      --wr-tone: var(--color-success);
      --wr-tone-bg: var(--color-success-container);
    }
    .wr__level--good {
      --wr-tone: var(--color-info);
      --wr-tone-bg: var(--color-info-container);
    }
    .wr__level--basic {
      --wr-tone: var(--color-text-secondary);
      --wr-tone-bg: var(--color-surface-2);
    }
    .wr__level--on,
    .wr__level--on:hover {
      background: var(--wr-tone-bg);
      box-shadow: inset 0 -2px 0 var(--wr-tone);
      color: var(--color-text-heading);
      font-weight: 700;
    }
    .wr__level--none.wr__level--on,
    .wr__level--none.wr__level--on:hover {
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    .wr__level--on app-icon {
      color: var(--wr-tone);
    }
    .wr__level:has(input:focus-visible) {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .wr__levels:disabled .wr__level {
      cursor: default;
    }
    .wr__levels:disabled .wr__level:not(.wr__level--on):hover {
      background: transparent;
      color: var(--color-text-secondary);
    }

    .wr__lock {
      display: inline-flex;
      flex: none;
      width: 2rem;
      height: 2rem;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .wr__lock:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .wr__lock[aria-pressed='true'] {
      border-color: var(--color-text-secondary);
      background: var(--color-surface-2);
      color: var(--color-text-heading);
    }
    .wr__lock:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    .wr__locked-hint {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin: 0.75rem 0 0;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    .wr__bar {
      position: sticky;
      inset-block-end: 0;
      z-index: 2;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem 0.75rem;
      margin: 1rem -1.5rem -1.5rem;
      padding: 0.75rem 1.5rem;
      border-top: 1px solid var(--color-border-strong);
      border-radius: 0 0 var(--radius-cards) var(--radius-cards);
      background: var(--color-surface);
    }
    .wr__dirty {
      margin-inline-end: auto;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }

    @container (max-width: 30rem) {
      .wr__row {
        flex-wrap: wrap;
      }
      .wr__levels {
        order: 3;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        flex: 1 1 100%;
      }
      .wr__level {
        min-width: 0;
        min-height: 2.25rem;
      }
    }
    @media (max-width: 56rem) {
      .wr__filters {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
      .wr__search {
        grid-column: 1 / -1;
      }
    }
    @media (max-width: 30rem) {
      .wr__filters {
        grid-template-columns: minmax(0, 1fr);
      }
      .wr__bar {
        margin-inline: -1rem;
        padding-inline: 1rem;
      }
    }
    @media (prefers-reduced-motion: no-preference) {
      .wr__level,
      .wr__lock,
      .wr__group-toggle {
        transition: background-color var(--motion-fast), color var(--motion-fast);
      }
    }
  `,
  template: `
    <article class="card p-6" [attr.aria-labelledby]="headingId">
      <header class="wr__header">
        <div class="wr__titles">
          <h2 class="wr__title" [id]="headingId">
            {{ isManage() ? t('weapons.admin.title') : t('weapons.title') }}
          </h2>
          <p class="wr__subtitle">
            {{ isManage() ? t('weapons.admin.subtitle') : t('weapons.subtitle') }}
          </p>
        </div>
        @if (!loading() && !loadFailed()) {
          <ul class="wr__summary" [attr.aria-label]="t('weapons.summaryLabel')">
            @for (level of proficiencies; track level) {
              <li>
                <span class="chip" [class]="'chip chip--' + tone(level)">
                  {{ t(labelKey(level)) }} <strong>{{ summary()[level] }}</strong>
                </span>
              </li>
            }
            @if (summary().locked > 0) {
              <li>
                <span class="chip chip--neutral">
                  <app-icon name="lock" size="0.75rem" />
                  {{ t('weapons.lockedCount', { count: summary().locked }) }}
                </span>
              </li>
            }
          </ul>
        }
      </header>

      @if (loading()) {
        <app-loading [label]="t('common.loading')" />
      } @else if (loadFailed()) {
        <app-error-state
          [message]="t('weapons.loadError')"
          [retryLabel]="t('common.retry')"
          (retry)="load()"
        />
      } @else if (entries().length === 0 || (!editable() && declaredCount() === 0 && summary().locked === 0)) {
        <div class="wr__empty">
          <app-empty-state
            [message]="entries().length === 0 ? t('weapons.catalogEmpty') : t('weapons.emptyAdmin')"
            icon="swords"
          />
        </div>
      } @else {
        @if (editable()) {
          <p class="wr__hint">
            <app-icon name="info" size="0.875rem" />
            {{ isManage() ? t('weapons.levelsHintAdmin') : t('weapons.levelsHint') }}
          </p>
        }

        <div class="wr__filters" role="search" [attr.aria-label]="t('weapons.filter.label')">
          <label class="wr__field">
            <span class="wr__field-label">{{ t('weapons.filter.search') }}</span>
            <span class="wr__search">
              <app-icon name="search" size="0.875rem" />
              <input
                type="search"
                class="input input--sm"
                autocomplete="off"
                [value]="query()"
                [placeholder]="t('weapons.filter.searchPlaceholder')"
                (input)="onQuery($event)"
              />
            </span>
          </label>
          <label class="wr__field">
            <span class="wr__field-label">{{ t('weapons.filter.family') }}</span>
            <select class="select select--sm" (change)="onFamily($event)">
              <option value="all" [selected]="family() === 'all'">
                {{ t('weapons.filter.familyAll') }}
              </option>
              @for (id of familyIds(); track id) {
                <option [value]="id" [selected]="family() === id">
                  {{ t(familyLabel(id)) }}
                </option>
              }
            </select>
          </label>
          <label class="wr__field">
            <span class="wr__field-label">{{ t('weapons.filter.level') }}</span>
            <select class="select select--sm" (change)="onLevel($event)">
              @for (option of levelFilters(); track option.id) {
                <option [value]="option.id" [selected]="levelFilter() === option.id">
                  {{ t(option.label) }}
                </option>
              }
            </select>
          </label>
          <button
            type="button"
            class="btn btn--outline btn--sm wr__toggle"
            [attr.aria-pressed]="levelFilter() === 'declared'"
            (click)="toggleDeclaredOnly()"
          >
            @if (levelFilter() === 'declared') {
              <app-icon name="check" size="0.875rem" />
            }
            {{ t('weapons.filter.declaredOnly') }}
          </button>
        </div>

        <div class="wr__toolbar">
          <span class="wr__count" role="status" aria-live="polite">
            {{ t('weapons.filter.count', { shown: visible().length, total: entries().length }) }}
          </span>
          @if (filtersActive()) {
            <button type="button" class="btn btn--ghost btn--sm" (click)="clearFilters()">
              {{ t('weapons.filter.clear') }}
            </button>
          }
          <button type="button" class="btn btn--ghost btn--sm" (click)="collapseAll()">
            {{ t('weapons.groups.collapseAll') }}
          </button>
          <button type="button" class="btn btn--ghost btn--sm" (click)="expandAll()">
            {{ t('weapons.groups.expandAll') }}
          </button>
        </div>

        @if (groups().length === 0) {
          <div class="wr__empty">
            <app-empty-state
              [message]="t('weapons.filter.noMatch')"
              [hint]="t('weapons.filter.noMatchHint')"
              icon="search"
            >
              <button type="button" class="btn btn--outline btn--sm" (click)="clearFilters()">
                {{ t('weapons.filter.clear') }}
              </button>
            </app-empty-state>
          </div>
        } @else {
          <div class="wr__groups">
            @for (group of groups(); track group.family) {
              <section class="wr__group">
                <h3 class="wr__group-title">
                  <button
                    type="button"
                    class="wr__group-toggle"
                    [attr.aria-expanded]="isOpen(group.family)"
                    [attr.aria-controls]="groupId(group.family)"
                    (click)="toggleGroup(group.family)"
                  >
                    <app-icon
                      [name]="isOpen(group.family) ? 'chevron-down' : 'chevron-right'"
                      size="0.875rem"
                    />
                    {{ t(familyLabel(group.family)) }}
                    <span class="wr__group-count" aria-hidden="true">
                      {{ group.declared }}/{{ group.entries.length }}
                    </span>
                    <span class="sr-only">
                      {{
                        t('weapons.group.counts', {
                          declared: group.declared,
                          total: group.entries.length,
                        })
                      }}
                    </span>
                  </button>
                </h3>
                @if (isOpen(group.family)) {
                  <ul class="wr__list" [id]="groupId(group.family)">
                    @for (entry of group.entries; track entry.key) {
                      <li
                        class="wr__row"
                        [class.wr__row--on]="entry.proficiency !== null"
                        [class.wr__row--locked]="entry.locked"
                      >
                        <span class="wr__tile" aria-hidden="true">
                          @if (isIconBroken(entry.key)) {
                            <app-icon name="swords" size="1.125rem" />
                          } @else {
                            <img
                              class="wr__icon"
                              [src]="iconFor(entry.key)"
                              alt=""
                              width="30"
                              height="30"
                              loading="lazy"
                              decoding="async"
                              (error)="markIconBroken(entry.key)"
                            />
                          }
                        </span>
                        <div class="wr__who">
                          <span class="wr__name">{{ entry.name }}</span>
                          @if (entry.locked) {
                            <span class="wr__state">
                              <app-icon name="lock" size="0.75rem" />
                              {{ isManage() ? t('weapons.locked') : t('weapons.lockedByOfficer') }}
                            </span>
                          }
                        </div>

                        <fieldset class="wr__levels" [disabled]="!canEditRow(entry)">
                          <legend class="sr-only">
                            {{ t('weapons.proficiency.level', { name: entry.name }) }}
                          </legend>
                          @for (choice of levelChoices; track choice.id) {
                            <label
                              [class]="'wr__level wr__level--' + choice.id"
                              [class.wr__level--on]="entry.proficiency === choice.level"
                            >
                              <input
                                type="radio"
                                class="sr-only"
                                [name]="radioName(entry.key)"
                                [value]="choice.id"
                                [checked]="entry.proficiency === choice.level"
                                (change)="setLevel(entry.key, choice.level)"
                              />
                              @if (choice.level !== null && entry.proficiency === choice.level) {
                                <app-icon name="check" size="0.75rem" />
                              }
                              {{ t(choice.label) }}
                            </label>
                          }
                        </fieldset>

                        @if (isManage() && editable()) {
                          <button
                            type="button"
                            class="wr__lock"
                            [attr.aria-pressed]="entry.locked"
                            [attr.aria-label]="t('weapons.lockFor', { name: entry.name })"
                            [attr.title]="t('weapons.lockToggle')"
                            (click)="toggleLock(entry.key)"
                          >
                            <app-icon name="lock" size="0.875rem" />
                          </button>
                        }
                      </li>
                    }
                  </ul>
                }
              </section>
            }
          </div>
          @if (!isManage() && summary().locked > 0) {
            <p class="wr__locked-hint">
              <app-icon name="lock" size="0.75rem" />
              {{ t('weapons.lockedHint') }}
            </p>
          }
        }

        @if (editable() && (dirty() || saving())) {
          <div class="wr__bar">
            <span class="wr__dirty" role="status">
              {{ t('weapons.unsavedCount', { count: changeCount() }) }}
            </span>
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              [disabled]="saving()"
              (click)="discard()"
            >
              {{ t('weapons.discard') }}
            </button>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              [disabled]="!dirty() || saving()"
              (click)="save()"
            >
              {{ saving() ? t('weapons.saving') : t('weapons.save') }}
            </button>
          </div>
        }
      }
      <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
    </article>
  `,
})
export class WeaponRoster {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);
  private readonly uid = nextRosterId++;

  /** `self` edits the signed-in member; `manage` is the officer view of another member. */
  readonly mode = input<'self' | 'manage'>('self');
  /** Member to load and save in `manage` mode. Ignored in `self` mode. */
  readonly userId = input<number | null>(null);
  /** False renders the list read-only (an officer without the manage permission). */
  readonly editable = input(true);

  protected readonly headingId = `weapon-roster-heading-${this.uid}`;
  protected readonly proficiencies = Object.keys(PROFICIENCY_LABEL) as WeaponProficiency[];
  protected readonly levelChoices = LEVEL_CHOICES;
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  /** Polite live-region text for changes that have no other visible confirmation. */
  protected readonly announcement = signal('');
  private readonly catalog = signal<readonly OpenAlbionItem[]>([]);
  private readonly saved = signal<readonly WeaponDraft[]>([]);
  /** Declared or locked weapons only; a weapon with neither is simply absent. */
  protected readonly drafts = signal<readonly WeaponDraft[]>([]);
  private readonly brokenIcons = signal<ReadonlySet<string>>(new Set());

  protected readonly query = signal('');
  protected readonly family = signal<WeaponFamilyId | 'all'>('all');
  /** The member's own pick; `null` falls back to the default for the current mode. */
  private readonly levelOverride = signal<WeaponLevelFilter | null>(null);
  private readonly collapsed = signal<ReadonlySet<WeaponFamilyId>>(new Set());

  protected readonly isManage = computed(() => this.mode() === 'manage');
  /** A read-only view starts on the declared weapons: the rest are all "none". */
  protected readonly levelFilter = computed<WeaponLevelFilter>(
    () => this.levelOverride() ?? (this.editable() ? 'all' : 'declared'),
  );
  protected readonly dirty = computed(() => this.changeCount() > 0);
  protected readonly changeCount = computed(() =>
    countWeaponDraftChanges(this.saved(), this.drafts()),
  );
  protected readonly summary = computed(() => summarizeWeaponDrafts(this.drafts()));
  protected readonly declaredCount = computed(
    () => this.drafts().filter((draft) => draft.proficiency !== null).length,
  );

  private readonly options = computed(() => weaponOptionsFromCatalog(this.catalog()));
  private readonly optionNames = computed(
    () => new Map(this.options().map((option) => [option.key, option.name] as const)),
  );
  protected readonly entries = computed(() => buildWeaponEntries(this.options(), this.drafts()));
  protected readonly familyIds = computed<readonly WeaponFamilyId[]>(() => {
    const present = new Set(this.entries().map((entry) => entry.family));
    return weaponFamilyOrder().filter((id) => present.has(id));
  });
  protected readonly levelFilters = computed(() =>
    this.isManage() || this.summary().locked > 0
      ? [...LEVEL_FILTERS, { id: 'locked' as const, label: 'weapons.locked' as TranslationKey }]
      : LEVEL_FILTERS,
  );
  private readonly filters = computed(() => ({
    query: this.query(),
    family: this.family(),
    level: this.levelFilter(),
  }));
  protected readonly filtersActive = computed(() => weaponFiltersActive(this.filters()));
  protected readonly visible = computed(() => filterWeaponEntries(this.entries(), this.filters()));
  protected readonly groups = computed(() => groupWeaponEntries(this.visible()));

  private loadedFor: string | null = null;
  private requestSeq = 0;

  constructor() {
    effect(() => {
      const path = this.apiPath();
      untracked(() => {
        if (path && path !== this.loadedFor) void this.load();
      });
    });
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  private apiPath(): string | null {
    if (this.mode() === 'self') return 'api/users/me/weapons';
    const id = this.userId();
    return id !== null && Number.isFinite(id) && id > 0 ? `api/users/${id}/weapons` : null;
  }

  protected labelKey(level: WeaponProficiency): TranslationKey {
    return PROFICIENCY_LABEL[level];
  }

  protected tone(level: WeaponProficiency): 'success' | 'info' | 'neutral' {
    return PROFICIENCY_TONE[level];
  }

  protected familyLabel(family: WeaponFamilyId): TranslationKey {
    return weaponFamilyLabelKey(family) as TranslationKey;
  }

  protected groupId(family: WeaponFamilyId): string {
    return `weapon-roster-${this.uid}-${family}`;
  }

  protected radioName(weaponKey: string): string {
    return `weapon-level-${weaponKey}`;
  }

  protected iconFor(weaponKey: string): string {
    return albionCombatIconUrl(weaponKey.replace(/^weapon:/, ''));
  }

  protected isIconBroken(weaponKey: string): boolean {
    return this.brokenIcons().has(weaponKey);
  }

  /** Some weapons have no render on the CDN; fall back to a generic icon instead of a broken image. */
  protected markIconBroken(weaponKey: string): void {
    this.brokenIcons.update((current) => new Set(current).add(weaponKey));
  }

  /** A member cannot touch a weapon an officer locked; an officer can edit any row. */
  protected canEditRow(entry: WeaponEntry): boolean {
    return this.editable() && (this.isManage() || !entry.locked);
  }

  /* ----------------------------------------------------------------- filters */

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.expandAll();
  }

  protected onFamily(event: Event): void {
    this.family.set((event.target as HTMLSelectElement).value as WeaponFamilyId | 'all');
    this.expandAll();
  }

  protected onLevel(event: Event): void {
    this.levelOverride.set((event.target as HTMLSelectElement).value as WeaponLevelFilter);
    this.expandAll();
  }

  protected toggleDeclaredOnly(): void {
    this.levelOverride.set(this.levelFilter() === 'declared' ? 'all' : 'declared');
    this.expandAll();
  }

  protected clearFilters(): void {
    this.query.set('');
    this.family.set('all');
    this.levelOverride.set('all');
    this.expandAll();
  }

  /* ------------------------------------------------------------------ groups */

  protected isOpen(family: WeaponFamilyId): boolean {
    return !this.collapsed().has(family);
  }

  protected toggleGroup(family: WeaponFamilyId): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (!next.delete(family)) next.add(family);
      return next;
    });
  }

  protected collapseAll(): void {
    this.collapsed.set(new Set(this.groups().map((group) => group.family)));
  }

  protected expandAll(): void {
    if (this.collapsed().size > 0) this.collapsed.set(new Set());
  }

  /* -------------------------------------------------------------------- data */

  protected async load(): Promise<void> {
    const path = this.apiPath();
    if (!path) return;
    this.loadedFor = path;
    const request = ++this.requestSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [rows, catalog] = await Promise.all([
        firstValueFrom(this.api.get<UserWeapon[]>(path)),
        this.albionCatalog.load(),
      ]);
      // A newer load (another member, or a retry) owns the state now.
      if (request !== this.requestSeq) return;
      this.catalog.set(catalog);
      this.adopt(Array.isArray(rows) ? rows : []);
    } catch (error) {
      if (request !== this.requestSeq) return;
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('weapons.loadError'));
    } finally {
      if (request === this.requestSeq) this.loading.set(false);
    }
  }

  private adopt(rows: readonly UserWeapon[]): void {
    const drafts = draftsFromWeapons(rows);
    this.saved.set(drafts);
    this.drafts.set(drafts);
  }

  /** Sets (or, with `null`, clears) a weapon's level. A cleared weapon without a lock is dropped. */
  protected setLevel(weaponKey: string, level: WeaponProficiency | null): void {
    this.patch(weaponKey, { proficiency: level });
  }

  protected toggleLock(weaponKey: string): void {
    const current = this.drafts().find((draft) => draft.weapon_key === weaponKey);
    this.patch(weaponKey, { locked: !(current?.locked ?? false) });
  }

  protected discard(): void {
    this.drafts.set(this.saved());
    this.announcement.set(this.t('weapons.discarded'));
  }

  private patch(weaponKey: string, change: Partial<WeaponDraft>): void {
    this.drafts.update((current) => {
      const existing = current.find((draft) => draft.weapon_key === weaponKey);
      const next: WeaponDraft = {
        weapon_key: weaponKey,
        weapon_name: existing?.weapon_name ?? this.optionNames().get(weaponKey) ?? weaponKey,
        proficiency: existing?.proficiency ?? null,
        locked: existing?.locked ?? false,
        ...change,
      };
      const rest = current.filter((draft) => draft.weapon_key !== weaponKey);
      return next.proficiency === null && !next.locked ? rest : [...rest, next];
    });
  }

  protected async save(): Promise<void> {
    const path = this.apiPath();
    if (!path || this.saving() || !this.dirty()) return;
    this.saving.set(true);
    try {
      const drafts = sortWeaponDrafts(this.drafts());
      const body = this.isManage() ? manageUserWeaponsRequest(drafts) : updateMyWeaponsRequest(drafts);
      const rows = await firstValueFrom(this.api.put<UserWeapon[]>(path, body));
      this.adopt(Array.isArray(rows) ? rows : []);
      this.announcement.set(this.t('weapons.saved'));
      this.toasts.success(this.t('weapons.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }
}
