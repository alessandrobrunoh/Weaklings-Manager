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
import { destinyWeaponFamilyLabelKey, type DestinyItemNode } from '../../data/albion-destiny-board';
import { albionCombatIconUrl } from '../../data/albion-equipment-catalog';
import {
  draftsFromWeapons,
  importDraftsFromSpecs,
  manageUserWeaponsRequest,
  sortWeaponDrafts,
  updateMyWeaponsRequest,
  weaponDraftsChanged,
  weaponOptionsFromCatalog,
  WEAPON_PROFICIENCIES,
  type WeaponDraft,
} from '../../data/user-weapons';
import { AlbionCatalogService } from '../../services/albion-catalog.service';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { Icon } from '../icon/icon';
import { Loading } from '../loading/loading';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../searchable-select/searchable-select';

const PROFICIENCY_LABEL: Readonly<Record<WeaponProficiency, TranslationKey>> = {
  main: 'weapons.proficiency.main',
  good: 'weapons.proficiency.good',
  basic: 'weapons.proficiency.basic',
};

/**
 * "My weapons": the weapons a member can play, each with a Main / Good / Basic level.
 *
 * `self` mode edits the signed-in member's list and can pre-fill it from the Destiny Board.
 * `manage` mode is the officer view of another member: it adds a per-weapon lock (also for a weapon
 * the member never declared) and is read-only unless `editable` is set. The component loads and
 * saves through the API itself so the profile and the member page share one implementation.
 */
@Component({
  selector: 'app-weapon-roster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, Icon, Loading, SearchableSelect],
  styles: `
    .wr__header {
      margin-bottom: 1rem;
    }
    .wr__toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .wr__picker {
      flex: 1 1 16rem;
      max-width: 24rem;
    }
    .wr__hint {
      margin: 0 0 0.75rem;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .wr__list {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .wr__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      padding: 0.5rem 0.75rem;
      border-top: 1px solid var(--color-border);
    }
    .wr__row:first-child {
      border-top: 0;
    }
    .wr__who {
      display: flex;
      flex: 1 1 12rem;
      min-width: 0;
      align-items: center;
      gap: 0.625rem;
    }
    .wr__icon {
      flex: none;
      width: 2rem;
      height: 2rem;
      object-fit: contain;
    }
    .wr__name {
      min-width: 0;
      overflow: hidden;
      font-size: 0.8125rem;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--color-text);
    }
    .wr__levels {
      display: inline-flex;
      margin: 0;
      padding: 0;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .wr__level {
      position: relative;
      display: inline-flex;
      min-height: 2rem;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem 0.625rem;
      border-inline-start: 1px solid var(--color-border);
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .wr__level:first-of-type {
      border-inline-start: 0;
    }
    .wr__level:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .wr__level--on,
    .wr__level--on:hover {
      background: var(--color-primary-container);
      color: var(--color-text-heading);
      font-weight: 700;
    }
    .wr__level:has(input:focus-visible) {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .wr__levels:disabled .wr__level {
      cursor: default;
    }
    .wr__levels:disabled .wr__level:hover {
      background: transparent;
      color: var(--color-text-secondary);
    }
    .wr__levels:disabled .wr__level--on:hover {
      background: var(--color-primary-container);
      color: var(--color-text-heading);
    }
    .wr__lock {
      display: inline-flex;
      min-height: 2rem;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      color: var(--color-text);
      cursor: pointer;
    }
    .wr__lock input {
      width: 1rem;
      height: 1rem;
      accent-color: var(--color-primary);
    }
    .wr__footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 0.75rem;
      margin-top: 0.75rem;
    }
    .wr__dirty {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    @media (prefers-reduced-motion: no-preference) {
      .wr__level {
        transition: background-color var(--motion-fast), color var(--motion-fast);
      }
    }
  `,
  template: `
    <article class="card p-6" aria-labelledby="weapon-roster-heading">
      <div class="wr__header">
        <h2 id="weapon-roster-heading" class="text-base font-semibold" style="color: var(--color-text)">
          {{ isManage() ? t('weapons.admin.title') : t('weapons.title') }}
        </h2>
        <p class="text-xs mt-1" style="color: var(--color-text-secondary)">
          {{ isManage() ? t('weapons.admin.subtitle') : t('weapons.subtitle') }}
        </p>
      </div>

      @if (loading()) {
        <app-loading [label]="t('common.loading')" />
      } @else if (loadFailed()) {
        <app-error-state
          [message]="t('weapons.loadError')"
          [retryLabel]="t('common.retry')"
          (retry)="load()"
        />
      } @else {
        @if (editable()) {
          <div class="wr__toolbar">
            <div class="wr__picker">
              <app-searchable-select
                [options]="pickerOptions()"
                [value]="''"
                [allowEmpty]="false"
                [emptyLabel]="t('weapons.add')"
                [searchPlaceholder]="t('weapons.addSearch')"
                [noMatchesLabel]="t('weapons.addNoMatch')"
                [emptyOptionsLabel]="t('weapons.addNone')"
                [ariaLabel]="t('weapons.add')"
                (valueChange)="addWeapon($event)"
              />
            </div>
            @if (!isManage()) {
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="saving()"
                (click)="importFromSpecs()"
              >
                <app-icon name="swords" size="0.875rem" />
                {{ t('weapons.import') }}
              </button>
            }
          </div>
          @if (!isManage()) {
            <p class="wr__hint">{{ t('weapons.importHint') }}</p>
          }
        }

        @if (drafts().length === 0) {
          <app-empty-state
            [message]="isManage() ? t('weapons.emptyAdmin') : t('weapons.empty')"
            icon="swords"
          />
        } @else {
          <ul class="wr__list" [attr.aria-label]="t('weapons.listLabel')">
            @for (draft of drafts(); track draft.weapon_key) {
              <li class="wr__row">
                <div class="wr__who">
                  <img
                    class="wr__icon"
                    [src]="iconFor(draft.weapon_key)"
                    alt=""
                    width="32"
                    height="32"
                    loading="lazy"
                  />
                  <span class="wr__name" [title]="draft.weapon_name">{{ draft.weapon_name }}</span>
                  @if (draft.locked) {
                    <span class="chip chip--error">
                      <app-icon name="lock" size="0.75rem" />
                      {{ t('weapons.locked') }}
                    </span>
                  }
                  @if (draft.proficiency === null) {
                    <span class="chip chip--neutral">{{ t('weapons.notDeclared') }}</span>
                  }
                </div>

                @if (draft.proficiency !== null || canEditRow(draft)) {
                  <fieldset class="wr__levels" [disabled]="!canEditRow(draft)">
                    <legend class="sr-only">
                      {{ t('weapons.proficiency.level', { name: draft.weapon_name }) }}
                    </legend>
                    @for (level of proficiencies; track level) {
                      <label class="wr__level" [class.wr__level--on]="draft.proficiency === level">
                        <input
                          type="radio"
                          class="sr-only"
                          [name]="'weapon-level-' + draft.weapon_key"
                          [value]="level"
                          [checked]="draft.proficiency === level"
                          (change)="setLevel(draft.weapon_key, level)"
                        />
                        @if (draft.proficiency === level) {
                          <app-icon name="check" size="0.75rem" />
                        }
                        {{ t(labelKey(level)) }}
                      </label>
                    }
                  </fieldset>
                }

                @if (isManage() && editable()) {
                  <label class="wr__lock">
                    <input
                      type="checkbox"
                      [checked]="draft.locked"
                      [attr.aria-label]="t('weapons.lockFor', { name: draft.weapon_name })"
                      (change)="onLockChange(draft.weapon_key, $event)"
                    />
                    {{ t('weapons.lockToggle') }}
                  </label>
                }

                @if (canRemoveRow(draft)) {
                  <button
                    type="button"
                    class="btn btn--ghost btn--icon btn--sm"
                    [attr.aria-label]="t('weapons.remove', { name: draft.weapon_name })"
                    (click)="removeWeapon(draft.weapon_key)"
                  >
                    <app-icon name="close" size="0.875rem" />
                  </button>
                }
              </li>
            }
          </ul>
          @if (!isManage() && hasLocked()) {
            <p class="wr__hint mt-2">
              <app-icon name="lock" size="0.75rem" />
              {{ t('weapons.lockedHint') }}
            </p>
          }
        }

        @if (editable()) {
          <div class="wr__footer">
            @if (dirty()) {
              <span class="wr__dirty" role="status">{{ t('weapons.unsaved') }}</span>
            }
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
    </article>
  `,
})
export class WeaponRoster {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);

  /** `self` edits the signed-in member; `manage` is the officer view of another member. */
  readonly mode = input<'self' | 'manage'>('self');
  /** Member to load and save in `manage` mode. Ignored in `self` mode. */
  readonly userId = input<number | null>(null);
  /** False renders the list read-only (an officer without the manage permission). */
  readonly editable = input(true);
  /** Destiny Board nodes used by "Import from Destiny Board". */
  readonly specNodes = input<readonly DestinyItemNode[]>([]);

  protected readonly proficiencies = WEAPON_PROFICIENCIES;
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  private readonly catalog = signal<readonly OpenAlbionItem[]>([]);
  private readonly saved = signal<readonly WeaponDraft[]>([]);
  protected readonly drafts = signal<readonly WeaponDraft[]>([]);

  protected readonly isManage = computed(() => this.mode() === 'manage');
  protected readonly dirty = computed(() => weaponDraftsChanged(this.saved(), this.drafts()));
  protected readonly hasLocked = computed(() => this.drafts().some((draft) => draft.locked));
  private readonly options = computed(() => weaponOptionsFromCatalog(this.catalog()));

  protected readonly pickerOptions = computed<SearchableSelectOption[]>(() => {
    const taken = new Set(this.drafts().map((draft) => draft.weapon_key));
    return this.options()
      .filter((option) => !taken.has(option.key))
      .map((option) => ({
        id: option.key,
        label: option.name,
        group: this.translate.t(destinyWeaponFamilyLabelKey(option.family) as TranslationKey),
      }));
  });

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

  protected iconFor(weaponKey: string): string {
    return albionCombatIconUrl(weaponKey.replace(/^weapon:/, ''));
  }

  /** A member cannot touch a weapon an officer locked; an officer can edit any row. */
  protected canEditRow(draft: WeaponDraft): boolean {
    return this.editable() && (this.isManage() || !draft.locked);
  }

  protected canRemoveRow(draft: WeaponDraft): boolean {
    return this.canEditRow(draft);
  }

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

  protected addWeapon(weaponKey: string): void {
    if (!weaponKey || this.drafts().some((draft) => draft.weapon_key === weaponKey)) return;
    const option = this.options().find((candidate) => candidate.key === weaponKey);
    if (!option) return;
    // An officer adds a weapon mostly to lock it; a member adds one to play it.
    const draft: WeaponDraft = this.isManage()
      ? { weapon_key: weaponKey, weapon_name: option.name, proficiency: null, locked: true }
      : { weapon_key: weaponKey, weapon_name: option.name, proficiency: 'good', locked: false };
    this.drafts.update((current) => [...current, draft]);
  }

  protected setLevel(weaponKey: string, level: WeaponProficiency): void {
    this.patch(weaponKey, { proficiency: level });
  }

  protected onLockChange(weaponKey: string, event: Event): void {
    this.patch(weaponKey, { locked: (event.target as HTMLInputElement).checked });
  }

  protected removeWeapon(weaponKey: string): void {
    this.drafts.update((current) => current.filter((draft) => draft.weapon_key !== weaponKey));
  }

  private patch(weaponKey: string, change: Partial<WeaponDraft>): void {
    this.drafts.update((current) =>
      current.map((draft) => (draft.weapon_key === weaponKey ? { ...draft, ...change } : draft)),
    );
  }

  protected importFromSpecs(): void {
    const { drafts, added } = importDraftsFromSpecs(this.drafts(), this.specNodes());
    if (added === 0) {
      this.toasts.info(this.t('weapons.importNone'));
      return;
    }
    this.drafts.set(drafts);
    this.toasts.info(this.t('weapons.importDone', { count: added }));
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
      this.toasts.success(this.t('weapons.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }
}
