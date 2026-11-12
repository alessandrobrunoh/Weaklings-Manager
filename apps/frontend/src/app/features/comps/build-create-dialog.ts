import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BuildDetail,
  BuildItemSlot,
  BuildItemSpells,
  BuildRole,
  BuildSlot,
  BuildSummary,
  CreateBuildRequest,
  OpenAlbionItem,
  OpenAlbionItemAbilities,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import type { AbilityChoiceChange } from '../../shared/components/ability-bar/ability-bar';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { OwnershipScopeToggle } from '../../shared/components/ownership-scope-toggle/ownership-scope-toggle';
import {
  BUILD_ROLES,
  RoleTag,
  roleGlyph,
  roleLabelKey,
} from '../../shared/components/role-tag/role-tag';
import { WeaponIcon } from '../../shared/components/weapon-icon/weapon-icon';
import {
  abilityCatalogKey,
  abilitySlotsFor,
  withAbilityChoice,
  type AbilitySlotView,
} from '../../shared/data/albion-abilities';
import {
  albionEquipmentIconUrl,
  filterAlbionEquipmentCatalog,
} from '../../shared/data/albion-equipment-catalog';
import {
  DEFAULT_ALBION_ITEM_ENCHANTMENT,
  normalizeAlbionItemEnchantment,
} from '../../shared/data/albion-item-enchantment';
import {
  DEFAULT_ALBION_ITEM_QUALITY,
  normalizeAlbionItemQuality,
} from '../../shared/data/albion-item-quality';
import { ownershipListParams, type OwnershipScope } from '../../shared/data/ownership-scope';
import { weaponKeyForIdentifier } from '../../shared/data/user-weapons';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { buildNeedsWeapon } from '../../shared/validation/build-validation';
import {
  MAX_BUILD_NAME_LENGTH,
  planCopyRole,
  stepOfField,
  validateBuildCreate,
  type BuildCreateError,
  type BuildCreateStep,
} from './build-create-model';
import { BUILD_ITEM_TIERS, mainSlotCapacity, weaponKeyOfItems } from './build-loadouts';
import { LIST_FETCH_LIMIT } from './comps-list-model';
import type { FilterCategory } from './list-filter-bar';

const EMPTY_SPELLS: BuildItemSpells = { active: {}, passive: {} };

/**
 * "New build": step 1 Basics, step 2 Loadout.
 *
 * Basics: name, role (a labelled group of role tags, never the raw `battle_mount` value), category,
 * description, and an optional "start from an existing build" list that says exactly what is copied
 * (the main loadout with its spells; the swap is not) and never overwrites a role the officer chose.
 * Loadout: the main set, through `app-equipment-grid`. Slots and tiers come from
 * `build-loadouts.ts`, the same lists the build page uses, so "9 of 10" means the same thing in both
 * places and a two-handed weapon does not count the off-hand as missing.
 *
 * Validation runs when the officer moves on or creates; a summary lists what to fix.
 */
@Component({
  selector: 'app-build-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Dialog,
    EmptyState,
    EquipmentGrid,
    ErrorState,
    Icon,
    Loading,
    OwnershipScopeToggle,
    RoleTag,
    WeaponIcon,
  ],
  styles: `
    .bc {
      display: grid;
      gap: 1rem;
    }
    .bc-steps {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1.5rem;
      margin: 0 0 0.25rem;
      padding: 0;
      list-style: none;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .bc-steps li {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }
    .bc-steps__n {
      display: inline-grid;
      place-items: center;
      width: 1.375rem;
      height: 1.375rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-full);
      font-family: var(--font-mono);
      font-size: 0.75rem;
    }
    .bc-steps li[aria-current='step'] {
      color: var(--color-text);
      font-weight: 600;
    }
    .bc-steps li[aria-current='step'] .bc-steps__n {
      border-color: var(--color-primary);
      background: var(--color-primary-container);
    }
    .bc-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem 1rem;
    }
    .bc-full {
      grid-column: 1 / -1;
    }
    .bc-fieldset {
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .bc-fieldset legend {
      padding: 0;
      margin-block-end: 0.25rem;
      font-size: 0.8125rem;
      font-weight: 500;
    }
    .bc-hint {
      margin: 0 0 0.5rem;
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text-secondary);
    }
    .bc-roles {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .bc-role {
      position: relative;
      display: inline-flex;
      padding: 0.25rem;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .bc-role input {
      position: absolute;
      inset: 0;
      margin: 0;
      opacity: 0;
      cursor: pointer;
    }
    .bc-role:has(input:checked) {
      border-color: var(--color-primary);
      background: var(--color-primary-container);
    }
    .bc-role:has(input:focus-visible) {
      outline: 2px solid var(--color-primary);
      outline-offset: 1px;
    }
    .bc-role:hover {
      background: var(--color-surface-hover);
    }
    .bc-copy {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .bc-copy__head {
      padding: 0.75rem;
      border-bottom: 1px solid var(--color-border);
    }
    .bc-copy__title {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .bc-copy__filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--color-border);
    }
    .bc-copy__filters label {
      flex: 1 1 12rem;
      min-width: 0;
    }
    .bc-list {
      max-height: 15rem;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .bc-list > li + li {
      border-top: 1px solid var(--color-border);
    }
    .bc-option {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.25rem 0.625rem;
      width: 100%;
      min-height: 2.75rem;
      padding: 0.5rem 0.75rem;
      border: 0;
      border-inline-start: 3px solid transparent;
      background: transparent;
      color: var(--color-text);
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .bc-option:hover {
      background: var(--color-surface-hover);
    }
    .bc-option:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .bc-option[aria-pressed='true'] {
      border-inline-start-color: var(--color-primary);
      background: var(--color-primary-container);
    }
    .bc-option__name {
      font-size: 0.875rem;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .bc-option__ver {
      margin-inline-start: 0.375rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 400;
      color: var(--color-text-secondary);
    }
    .bc-option__meta {
      display: block;
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text-secondary);
    }
    .bc-empty-icon {
      display: inline-grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      border: 1px dashed var(--color-border-strong);
      border-radius: var(--radius-sm);
      color: var(--color-text-secondary);
    }
    .bc-copy__status {
      margin: 0;
      padding: 0.625rem 0.75rem;
      border-top: 1px solid var(--color-border);
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .bc-copy__status p {
      margin: 0;
    }
    .bc-copy__status p + p {
      margin-block-start: 0.25rem;
    }
    .bc-loadout__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
    }
    .bc-loadout__facts {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .bc-loadout__facts strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .bc-progress {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .bc-field-error {
      margin: 0.25rem 0 0;
      font-size: 0.75rem;
      color: var(--color-error);
    }
    .bc-summary {
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-error);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      font-size: 0.8125rem;
    }
    .bc-summary strong {
      display: block;
      margin-block-end: 0.25rem;
      font-weight: 600;
    }
    .bc-summary ul {
      margin: 0;
      padding-inline-start: 1.125rem;
    }
    @media (max-width: 40rem) {
      .bc-grid {
        grid-template-columns: 1fr;
      }
    }
  `,
  template: `
    <app-dialog [title]="t('buildCreate.title')" [subtitle]="t('buildCreate.subtitle')" size="xl" (closed)="closed.emit()">
      <ol class="bc-steps" [attr.aria-label]="t('buildCreate.steps')">
        <li [attr.aria-current]="step() === 'basics' ? 'step' : null">
          <span class="bc-steps__n" aria-hidden="true">1</span>{{ t('buildCreate.step.basics') }}
        </li>
        <li [attr.aria-current]="step() === 'loadout' ? 'step' : null">
          <span class="bc-steps__n" aria-hidden="true">2</span>{{ t('buildCreate.step.loadout') }}
        </li>
      </ol>

      <form id="build-create-form" class="bc" novalidate (submit)="onSubmit($event)">
        @if (step() === 'basics') {
          <div class="bc-grid">
            <label>
              <span class="label">{{ t('common.name') }}</span>
              <input
                class="input"
                type="text"
                autocomplete="off"
                required
                [value]="name()"
                [attr.aria-invalid]="errorFor('name') ? 'true' : null"
                [attr.aria-describedby]="errorFor('name') ? 'bc-name-error' : null"
                (input)="name.set($any($event.target).value)"
              />
              @if (errorFor('name'); as error) {
                <p id="bc-name-error" class="bc-field-error">{{ message(error) }}</p>
              }
            </label>
            <label>
              <span class="label">{{ t('common.category') }}</span>
              <select
                class="select"
                required
                [value]="categoryId()"
                [attr.aria-invalid]="errorFor('category') ? 'true' : null"
                [attr.aria-describedby]="errorFor('category') ? 'bc-category-error' : null"
                (change)="categoryId.set($any($event.target).value)"
              >
                <option value="">{{ t('comps.selectCategory') }}</option>
                @for (category of categories(); track category.id) {
                  <option [value]="category.id">{{ category.name }}</option>
                }
              </select>
              @if (errorFor('category'); as error) {
                <p id="bc-category-error" class="bc-field-error">{{ message(error) }}</p>
              }
            </label>

            <fieldset class="bc-fieldset bc-full">
              <legend>{{ t('common.role') }}</legend>
              <p class="bc-hint" id="bc-role-hint">{{ t('buildCreate.role.hint') }}</p>
              <div class="bc-roles" role="radiogroup" aria-describedby="bc-role-hint">
                @for (option of roles; track option) {
                  <label class="bc-role">
                    <input
                      type="radio"
                      name="bc-role"
                      [value]="option"
                      [checked]="role() === option"
                      (change)="chooseRole(option)"
                    />
                    <app-role-tag [role]="option" />
                  </label>
                }
              </div>
            </fieldset>

            <label class="bc-full">
              <span class="label">{{ t('common.description') }}</span>
              <textarea
                class="textarea"
                rows="2"
                [value]="description()"
                (input)="description.set($any($event.target).value)"
              ></textarea>
            </label>
          </div>

          <section class="bc-copy" aria-labelledby="bc-copy-title">
            <div class="bc-copy__head">
              <h3 id="bc-copy-title" class="bc-copy__title">{{ t('buildCreate.copy.title') }}</h3>
              <p class="bc-hint" style="margin: 0.25rem 0 0">{{ t('buildCreate.copy.hint') }}</p>
            </div>
            <div class="bc-copy__filters" role="search">
              <label>
                <span class="sr-only">{{ t('comps.searchBuilds') }}</span>
                <input
                  type="search"
                  class="input"
                  autocomplete="off"
                  [placeholder]="t('comps.searchBuilds')"
                  [value]="search()"
                  (input)="onSearch($event)"
                />
              </label>
              <app-ownership-scope-toggle [scope]="scope()" (scopeChange)="setScope($event)" />
            </div>
            <div [attr.aria-busy]="catalogLoading()">
              @if (catalogFailed()) {
                <app-error-state
                  [message]="t('compDetail.add.loadFailed')"
                  [retryLabel]="t('common.retry')"
                  (retry)="loadCatalog()"
                />
              } @else {
                <ul class="bc-list" [attr.aria-label]="t('buildCreate.copy.listLabel')">
                  <li>
                    <button
                      type="button"
                      class="bc-option"
                      [attr.aria-pressed]="template() === null"
                      (click)="pickTemplate(null)"
                    >
                      <span class="bc-empty-icon" aria-hidden="true"><app-icon name="plus" size="0.875rem" /></span>
                      <span>
                        <span class="bc-option__name">{{ t('buildCreate.copy.empty') }}</span>
                        <span class="bc-option__meta">{{ t('buildCreate.copy.emptyHint') }}</span>
                      </span>
                      @if (template() === null) {
                        <app-icon name="check" size="1rem" />
                      }
                    </button>
                  </li>
                  @if (catalogLoading() && catalog().length === 0) {
                    <li class="py-4"><app-loading [label]="t('common.loading')" /></li>
                  }
                  @for (entry of catalog(); track entry.id) {
                    <li>
                      <button
                        type="button"
                        class="bc-option"
                        [attr.aria-pressed]="template()?.id === entry.id"
                        (click)="pickTemplate(entry)"
                      >
                        <app-weapon-icon size="sm" [weaponKey]="entry.weapon_key" [fallback]="glyph(entry.role)" />
                        <span style="min-width: 0">
                          <span class="bc-option__name">{{ entry.name }}</span>
                          <span class="bc-option__ver">v{{ entry.version }}</span>
                          <span class="bc-option__meta">
                            {{ entry.weapon_name || t('comps.noWeapon') }} · {{ entry.category_name || t('comps.noCategory') }} ·
                            {{ entry.created_by_username }}
                          </span>
                        </span>
                        <span style="display: inline-flex; align-items: center; gap: 0.5rem">
                          <app-role-tag [role]="entry.role" />
                          @if (template()?.id === entry.id) {
                            <app-icon name="check" size="1rem" />
                          }
                        </span>
                      </button>
                    </li>
                  }
                  @if (!catalogLoading() && catalog().length === 0) {
                    <li>
                      <app-empty-state
                        icon="package"
                        [message]="t('comps.noBuildsAvailable')"
                        [hint]="t('compDetail.add.emptyHint')"
                      />
                    </li>
                  }
                </ul>
              }
            </div>
            <div class="bc-copy__status" role="status" aria-live="polite">
              @if (templateLoading()) {
                <p>{{ t('loadout.loading') }}</p>
              } @else if (template(); as chosen) {
                <p>
                  {{ t('buildCreate.copy.copies', { count: chosen.main_item_count, name: chosen.name }) }}
                </p>
                @if (swapSkipped() > 0) {
                  <p>{{ t('buildCreate.copy.swapSkipped', { count: swapSkipped() }) }}</p>
                } @else {
                  <p>{{ t('buildCreate.copy.noSwap') }}</p>
                }
                @if (roleNote() === 'set') {
                  <p>{{ t('buildCreate.copy.roleSet', { role: t(roleKey(chosen.role)) }) }}</p>
                } @else if (roleNote() === 'kept') {
                  <p>
                    {{ t('buildCreate.copy.roleKept', { role: t(roleKey(role())), other: t(roleKey(chosen.role)) }) }}
                  </p>
                }
              } @else {
                <p>{{ t('buildCreate.copy.nothing') }}</p>
              }
            </div>
          </section>
        } @else {
          <div class="bc-loadout__head">
            <div class="bc-loadout__facts">
              <strong>{{ name().trim() }}</strong>
              <app-role-tag [role]="role()" />
              <span>{{ categoryName() }}</span>
            </div>
            <span class="bc-progress" [attr.title]="t('buildCreate.loadout.progressTitle')">
              {{ t('buildCreate.loadout.progress', { filled: filledCount(), total: slotTotal() }) }}
            </span>
          </div>
          <p class="bc-hint" style="margin: 0">
            {{ t('buildCreate.loadout.hint') }}
            @if (!needsWeapon()) {
              {{ t('buildCreate.loadout.weaponOptional') }}
            } @else {
              {{ t('buildCreate.loadout.weaponRequired') }}
            }
          </p>
          @if (errorFor('weapon'); as error) {
            <p class="bc-field-error">{{ message(error) }}</p>
          }
          <app-equipment-grid
            [items]="items()"
            [canManage]="true"
            [editingSlot]="editSlot()"
            [draftTier]="draftTier()"
            [draftQuality]="draftQuality()"
            [draftEnchantment]="draftEnchantment()"
            [draftSearch]="draftSearch()"
            [draftItemId]="selectedItemId()"
            [searchResults]="searchResults()"
            [searchLoading]="searchLoading()"
            [tiers]="tiers"
            [draftAbilitySlots]="draftAbilitySlots()"
            (slotToggle)="onSlotToggle($event)"
            (tierChange)="onTierChange($event)"
            (qualityChange)="draftQuality.set(normalizeQuality($event))"
            (enchantmentChange)="draftEnchantment.set(normalizeEnchantment($event))"
            (searchChange)="onSearchChange($event)"
            (itemSelect)="onItemSelect($event)"
            (saveSlot)="onSaveSlot()"
            (cancelEdit)="onCancelSlot()"
            (removeItem)="removeItem($event)"
            (abilityChoice)="onAbilityChoice($event)"
          />
        }

        @if (submitted() && visibleErrors().length > 0) {
          <div class="bc-summary" role="alert">
            <strong>{{ t('buildCreate.summary.title') }}</strong>
            <ul>
              @for (error of visibleErrors(); track error.field) {
                <li>{{ message(error) }}</li>
              }
            </ul>
          </div>
        }
      </form>

      <div dialogFooter>
        <button type="button" class="btn btn--ghost" (click)="closed.emit()">
          {{ t('common.cancel') }}
        </button>
        @if (step() === 'loadout') {
          <button type="button" class="btn btn--outline" (click)="goBack()">
            {{ t('buildCreate.back') }}
          </button>
        }
        <button type="submit" class="btn btn--primary" form="build-create-form" [disabled]="saving()">
          {{ step() === 'basics' ? t('common.next') : t('comps.createBuild') }}
        </button>
      </div>
    </app-dialog>
  `,
})
export class BuildCreateDialog {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);
  private readonly albionAbilities = inject(AlbionAbilitiesService);

  /** Build categories to file the new build under. */
  readonly categories = input.required<readonly FilterCategory[]>();

  /** The build was created. */
  readonly created = output<BuildDetail>();
  readonly closed = output<void>();

  protected readonly roles = BUILD_ROLES;
  protected readonly roleKey = roleLabelKey;
  protected readonly glyph = roleGlyph;
  protected readonly tiers = BUILD_ITEM_TIERS;
  protected readonly normalizeQuality = normalizeAlbionItemQuality;
  protected readonly normalizeEnchantment = normalizeAlbionItemEnchantment;

  protected readonly step = signal<BuildCreateStep>('basics');
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);

  // ---- basics
  protected readonly name = signal('');
  protected readonly categoryId = signal('');
  protected readonly description = signal('');
  protected readonly role = signal<BuildRole>('dps');
  /** The officer picked a role themselves, so copying a build must not overwrite it. */
  private readonly roleTouched = signal(false);
  private readonly existingNames = signal<readonly string[]>([]);

  // ---- copy from
  protected readonly search = signal('');
  protected readonly scope = signal<OwnershipScope>('mine');
  protected readonly catalog = signal<readonly BuildSummary[]>([]);
  protected readonly catalogLoading = signal(false);
  protected readonly catalogFailed = signal(false);
  protected readonly template = signal<BuildSummary | null>(null);
  protected readonly templateLoading = signal(false);
  protected readonly roleNote = signal<'set' | 'kept' | null>(null);

  // ---- loadout (main set only)
  protected readonly items = signal<readonly BuildItemSlot[]>([]);
  private readonly weaponKey = signal<string | null>(null);
  protected readonly editSlot = signal<BuildSlot | null>(null);
  protected readonly draftTier = signal('T8');
  protected readonly draftQuality = signal(DEFAULT_ALBION_ITEM_QUALITY);
  protected readonly draftEnchantment = signal<number>(DEFAULT_ALBION_ITEM_ENCHANTMENT);
  protected readonly draftSearch = signal('');
  protected readonly selectedItemId = signal('');
  protected readonly searchResults = signal<OpenAlbionItem[]>([]);
  protected readonly searchLoading = signal(false);
  private readonly abilityCatalog = signal<Record<string, OpenAlbionItemAbilities>>({});
  private readonly draftAbilityKey = signal<string | null>(null);
  private readonly draftSpells = signal<BuildItemSpells>(EMPTY_SPELLS);
  private readonly draftItem = signal<OpenAlbionItem | null>(null);

  protected readonly draftAbilitySlots = computed<AbilitySlotView[]>(() => {
    const slot = this.editSlot();
    const key = this.draftAbilityKey();
    return slot && key ? abilitySlotsFor(slot, this.abilityCatalog()[key], this.draftSpells()) : [];
  });

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogSeq = 0;
  private templateSeq = 0;

  /** Whether the role needs a main-hand weapon (a battle mount does not). */
  protected readonly needsWeapon = computed(() => buildNeedsWeapon(this.role()));
  protected readonly slotTotal = computed(() => mainSlotCapacity(this.weaponKey()));
  protected readonly filledCount = computed(() => this.items().length);
  protected readonly swapSkipped = computed(() => {
    const chosen = this.template();
    return chosen ? Math.max(chosen.item_count - chosen.main_item_count, 0) : 0;
  });

  protected readonly categoryName = computed(
    () =>
      this.categories().find((category) => String(category.id) === this.categoryId())?.name ??
      this.t('comps.noCategory'),
  );

  protected readonly errors = computed<BuildCreateError[]>(() => {
    const categoryId = Number(this.categoryId());
    return validateBuildCreate(
      {
        name: this.name(),
        categoryId: categoryId > 0 ? categoryId : null,
        role: this.role(),
        hasWeapon: this.items().some((item) => item.slot === 'weapon'),
      },
      this.existingNames(),
    );
  });

  /** Errors of the step on screen; "Next" never blames a field the officer has not seen. */
  protected readonly visibleErrors = computed(() =>
    this.step() === 'basics'
      ? this.errors().filter((error) => stepOfField(error.field) === 'basics')
      : this.errors(),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.catalogSeq += 1;
      this.templateSeq += 1;
      for (const timer of [this.searchTimer, this.catalogTimer]) {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
    });
    void this.loadCatalog();
    void this.loadNames();
    // Static application data; one fetch serves every item opened in the session.
    void this.albionAbilities
      .load()
      .then((abilities) => this.abilityCatalog.set(abilities))
      .catch(() => this.abilityCatalog.set({}));
  }

  protected errorFor(field: BuildCreateError['field']): BuildCreateError | null {
    return this.submitted() ? (this.visibleErrors().find((error) => error.field === field) ?? null) : null;
  }

  protected message(error: BuildCreateError): string {
    switch (error.field) {
      case 'name':
        return error.code === 'tooLong'
          ? this.t('buildCreate.err.nameLong', { max: MAX_BUILD_NAME_LENGTH })
          : error.code === 'taken'
            ? this.t('buildCreate.err.nameTaken')
            : this.t('buildCreate.err.name');
      case 'category':
        return this.t('buildCreate.err.category');
      case 'weapon':
        return this.t('comps.weaponRequired');
    }
  }

  protected chooseRole(role: BuildRole): void {
    this.role.set(role);
    this.roleTouched.set(true);
    this.roleNote.set(null);
  }

  // ---- steps -----------------------------------------------------------------------------------

  protected onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (this.step() === 'basics') {
      this.submitted.set(true);
      if (this.visibleErrors().length === 0) {
        this.submitted.set(false);
        this.step.set('loadout');
      }
      return;
    }
    this.submitted.set(true);
    if (this.errors().length === 0) {
      void this.create();
    }
  }

  protected goBack(): void {
    this.submitted.set(false);
    this.onCancelSlot();
    this.step.set('basics');
  }

  // ---- copy from -------------------------------------------------------------------------------

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    if (this.catalogTimer !== null) {
      clearTimeout(this.catalogTimer);
    }
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = null;
      void this.loadCatalog();
    }, 250);
  }

  protected setScope(scope: OwnershipScope): void {
    if (scope === this.scope()) {
      return;
    }
    this.scope.set(scope);
    void this.loadCatalog();
  }

  /** Picks a build to copy (`null` starts empty). Only the main loadout is copied. */
  protected async pickTemplate(build: BuildSummary | null): Promise<void> {
    const seq = ++this.templateSeq;
    this.template.set(build);
    this.roleNote.set(null);
    this.onCancelSlot();
    if (build === null) {
      this.items.set([]);
      this.weaponKey.set(null);
      return;
    }
    const plan = planCopyRole({
      current: this.role(),
      touched: this.roleTouched(),
      copied: build.role,
    });
    this.role.set(plan.role);
    this.roleNote.set(plan.note);
    this.templateLoading.set(true);
    try {
      const detail = await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${build.id}`));
      if (seq !== this.templateSeq) {
        return;
      }
      const main = detail.items.filter((item) => (item.loadout ?? 'main') === 'main');
      this.items.set(main.map((item) => ({ ...item, loadout: 'main' as const })));
      this.weaponKey.set(build.weapon_key ?? weaponKeyOfItems(main));
    } catch {
      if (seq !== this.templateSeq) {
        return;
      }
      this.template.set(null);
      this.roleNote.set(null);
      this.items.set([]);
      this.weaponKey.set(null);
      this.toasts.error(this.t('buildCreate.copy.failed'));
    } finally {
      if (seq === this.templateSeq) {
        this.templateLoading.set(false);
      }
    }
  }

  protected async loadCatalog(): Promise<void> {
    const seq = ++this.catalogSeq;
    this.catalogLoading.set(true);
    this.catalogFailed.set(false);
    try {
      const query = this.search().trim();
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: 100,
          sort: 'name',
          order: 'asc',
          q: query || undefined,
          ...ownershipListParams(this.scope()),
        }),
      );
      if (seq === this.catalogSeq) {
        this.catalog.set(
          [...response.items].sort(
            (left, right) =>
              left.name.localeCompare(right.name, this.translate.locale()) || right.version - left.version,
          ),
        );
      }
    } catch {
      if (seq === this.catalogSeq) {
        this.catalog.set([]);
        this.catalogFailed.set(true);
      }
    } finally {
      if (seq === this.catalogSeq) {
        this.catalogLoading.set(false);
      }
    }
  }

  /** Names of every existing build, so a duplicate is caught before the request. */
  private async loadNames(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: LIST_FETCH_LIMIT,
          sort: 'name',
          order: 'asc',
        }),
      );
      this.existingNames.set(response.items.map((build) => build.name));
    } catch {
      this.existingNames.set([]);
    }
  }

  // ---- loadout: item draft ---------------------------------------------------------------------

  protected onSlotToggle(slot: BuildSlot): void {
    if (this.editSlot() === slot) {
      this.onCancelSlot();
      return;
    }
    this.editSlot.set(slot);
    this.resetDraft();
    void this.searchItems();
  }

  protected onTierChange(tier: string): void {
    this.draftTier.set(tier);
    this.clearSelected();
    void this.searchItems();
  }

  protected onSearchChange(query: string): void {
    this.draftSearch.set(query);
    this.clearSelected();
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.searchItems();
    }, 250);
  }

  protected onItemSelect(itemId: string): void {
    this.selectedItemId.set(itemId);
    const item = this.searchResults().find((candidate) => String(candidate.id) === itemId);
    if (!item) {
      this.clearSelected();
      return;
    }
    this.draftItem.set(item);
    this.draftTier.set(normalizeTier(item.tier));
    const key = item.identifier ? abilityCatalogKey(item.identifier) : null;
    // A different weapon family offers different slots, so a stale choice does not carry over onto
    // abilities the new item cannot cast.
    if (key !== this.draftAbilityKey()) {
      this.draftSpells.set(EMPTY_SPELLS);
    }
    this.draftAbilityKey.set(key);
  }

  protected onAbilityChoice(change: AbilityChoiceChange): void {
    this.draftSpells.update((spells) =>
      withAbilityChoice(spells, change.kind, change.index, change.spellId),
    );
  }

  protected onSaveSlot(): void {
    const slot = this.editSlot();
    const picked = this.draftItem();
    if (!slot || !picked) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const item: BuildItemSlot = {
      // The create flow builds the main set only; the swap is added on the build page.
      loadout: 'main',
      slot,
      openalbion_item_type: picked.type,
      openalbion_item_id: picked.id,
      openalbion_item_name: picked.name,
      openalbion_item_quality: this.draftQuality(),
      openalbion_item_enchantment: this.draftEnchantment(),
    };
    const icon = itemIconUrl(picked);
    if (icon) {
      item.openalbion_item_icon = icon;
    }
    const tier = this.draftTier().trim();
    if (tier) {
      item.openalbion_item_tier = tier;
    }
    const spells = this.draftSpells();
    if (Object.keys(spells.active).length > 0 || Object.keys(spells.passive).length > 0) {
      item.spells = spells;
    }
    this.items.update((current) => [...current.filter((existing) => existing.slot !== slot), item]);
    if (slot === 'weapon') {
      this.weaponKey.set(picked.identifier ? weaponKeyForIdentifier(picked.identifier) : weaponKeyOfItems([item]));
    }
    this.onCancelSlot();
  }

  protected onCancelSlot(): void {
    this.editSlot.set(null);
    this.resetDraft();
  }

  protected removeItem(slot: BuildSlot): void {
    this.items.update((current) => current.filter((item) => item.slot !== slot));
    if (slot === 'weapon') {
      this.weaponKey.set(null);
    }
  }

  private resetDraft(): void {
    this.draftSearch.set('');
    this.searchResults.set([]);
    this.draftQuality.set(DEFAULT_ALBION_ITEM_QUALITY);
    this.draftEnchantment.set(DEFAULT_ALBION_ITEM_ENCHANTMENT);
    this.clearSelected();
  }

  private clearSelected(): void {
    this.selectedItemId.set('');
    this.draftItem.set(null);
    this.draftAbilityKey.set(null);
    this.draftSpells.set(EMPTY_SPELLS);
  }

  private async searchItems(): Promise<void> {
    const slot = this.editSlot();
    if (!slot) {
      this.searchResults.set([]);
      return;
    }
    this.searchLoading.set(true);
    try {
      const catalog = await this.albionCatalog.load();
      this.searchResults.set(
        filterAlbionEquipmentCatalog(catalog, this.draftSearch(), slot, this.draftTier()),
      );
    } catch {
      this.searchResults.set([]);
      this.toasts.error(this.t('common.error'));
    } finally {
      this.searchLoading.set(false);
    }
  }

  // ---- create ------------------------------------------------------------------------------------

  private async create(): Promise<void> {
    const request: CreateBuildRequest = {
      name: this.name().trim(),
      category_id: Number(this.categoryId()),
      role: this.role(),
    };
    const description = this.description().trim();
    if (description) {
      request.description = description;
    }
    if (this.items().length > 0) {
      request.items = [...this.items()];
    }
    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.post<BuildDetail>('api/comps/builds', request));
      this.toasts.success(this.t('buildCreate.created'));
      this.created.emit(created);
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}

/** `8` and `T8.1` both read as `T8`. */
function normalizeTier(tier: string): string {
  const normalized = tier.trim().toUpperCase();
  return normalized.startsWith('T') ? normalized.split('.')[0] : `T${normalized.split('.')[0]}`;
}

function itemIconUrl(item: OpenAlbionItem): string {
  if (item.icon) {
    return item.icon;
  }
  return item.identifier ? albionEquipmentIconUrl(item.identifier) : '';
}
