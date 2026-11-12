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
import { weaponFamilyLabelKey, type WeaponFamilyId } from '../../data/albion-weapon-families';
import { albionCombatIconUrl } from '../../data/albion-equipment-catalog';
import {
  draftsFromWeapons,
  groupWeaponDrafts,
  manageUserWeaponsRequest,
  sortWeaponDrafts,
  summarizeWeaponDrafts,
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

/** Same tones the event bench uses for these levels, so a level reads the same everywhere. */
const PROFICIENCY_TONE: Readonly<Record<WeaponProficiency, 'success' | 'info' | 'neutral'>> = {
  main: 'success',
  good: 'info',
  basic: 'neutral',
};

let nextRosterId = 0;

/**
 * "My weapons": the weapons a member can play, each with a Main / Good / Basic level.
 *
 * Weapons are grouped by family and sorted by name inside a family, so changing a level never
 * moves a row (keyboard focus stays where it is). `self` mode edits the signed-in member's list.
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

    .wr__add {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
      margin-bottom: 1rem;
      padding: 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-muted);
    }
    .wr__picker {
      flex: 1 1 16rem;
      max-width: 26rem;
    }
    .wr__hint {
      display: flex;
      flex: 1 1 14rem;
      align-items: flex-start;
      gap: 0.375rem;
      margin: 0;
      font-size: 0.75rem;
      line-height: 1.4;
      color: var(--color-text-secondary);
    }
    .wr__hint app-icon {
      flex: none;
      margin-top: 0.0625rem;
    }

    .wr__empty {
      border: 1px dashed var(--color-border-strong);
      border-radius: var(--radius-md);
    }

    .wr__groups {
      display: grid;
      gap: 1rem;
    }
    .wr__group-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0 0 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .wr__group-count {
      min-width: 1.25rem;
      padding: 0 0.375rem;
      border-radius: var(--radius-pills);
      background: var(--color-surface-2);
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      text-align: center;
      letter-spacing: 0;
      color: var(--color-text-secondary);
    }
    .wr__list {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .wr__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      padding: 0.5rem 0.75rem;
      border-top: 1px solid var(--color-border);
      border-inline-start: 3px solid transparent;
    }
    .wr__row:first-child {
      border-top: 0;
    }
    .wr__row--locked {
      border-inline-start-color: var(--color-border-strong);
      background: var(--color-surface-muted);
    }

    .wr__tile {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .wr__icon {
      width: 2.125rem;
      height: 2.125rem;
      object-fit: contain;
    }
    .wr__who {
      display: flex;
      flex: 1 1 0;
      min-width: 8rem;
      flex-direction: column;
      gap: 0.125rem;
    }
    .wr__name {
      overflow-wrap: anywhere;
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.25;
      color: var(--color-text);
    }
    .wr__state {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.6875rem;
      color: var(--color-text-secondary);
    }

    .wr__levels {
      display: inline-flex;
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
      min-height: 2.25rem;
      min-width: 4.25rem;
      align-items: center;
      justify-content: center;
      gap: 0.25rem;
      padding: 0.25rem 0.75rem;
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
      min-height: 2.25rem;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: transparent;
      font-size: 0.75rem;
      font-weight: 500;
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
      font-weight: 700;
    }
    .wr__lock:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    .wr__footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem 0.75rem;
      margin-top: 1rem;
    }
    .wr__dirty {
      margin-inline-end: auto;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .wr__locked-hint {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin: 0.75rem 0 0;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    @media (max-width: 40rem) {
      .wr__levels {
        order: 3;
        flex: 1 1 100%;
      }
      .wr__level {
        flex: 1 1 0;
        min-height: 2.5rem;
      }
      .wr__lock {
        min-height: 2.5rem;
      }
    }
    @media (prefers-reduced-motion: no-preference) {
      .wr__level,
      .wr__lock {
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
        @if (!loading() && !loadFailed() && drafts().length > 0) {
          <ul class="wr__summary" [attr.aria-label]="t('weapons.summaryLabel')">
            @for (level of proficiencies; track level) {
              @if (summary()[level] > 0) {
                <li>
                  <span class="chip" [class]="'chip chip--' + tone(level)">
                    {{ t(labelKey(level)) }} <strong>{{ summary()[level] }}</strong>
                  </span>
                </li>
              }
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
      } @else {
        @if (editable()) {
          <div class="wr__add">
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
            <p class="wr__hint">
              <app-icon name="info" size="0.875rem" />
              {{ isManage() ? t('weapons.levelsHintAdmin') : t('weapons.levelsHint') }}
            </p>
          </div>
        }

        @if (groups().length === 0) {
          <div class="wr__empty">
            <app-empty-state
              [message]="isManage() ? t('weapons.emptyAdmin') : t('weapons.empty')"
              [hint]="isManage() ? t('weapons.emptyAdminHint') : t('weapons.emptyHint')"
              icon="swords"
            />
          </div>
        } @else {
          <div class="wr__groups">
            @for (group of groups(); track group.family) {
              <section [attr.aria-labelledby]="groupId(group.family)">
                <h3 class="wr__group-title" [id]="groupId(group.family)">
                  {{ t(familyLabel(group.family)) }}
                  <span class="wr__group-count">{{ group.drafts.length }}</span>
                </h3>
                <ul class="wr__list">
                  @for (draft of group.drafts; track draft.weapon_key) {
                    <li class="wr__row" [class.wr__row--locked]="draft.locked">
                      <span class="wr__tile" aria-hidden="true">
                        @if (isIconBroken(draft.weapon_key)) {
                          <app-icon name="swords" size="1.25rem" />
                        } @else {
                          <img
                            class="wr__icon"
                            [src]="iconFor(draft.weapon_key)"
                            alt=""
                            width="34"
                            height="34"
                            loading="lazy"
                            (error)="markIconBroken(draft.weapon_key)"
                          />
                        }
                      </span>
                      <div class="wr__who">
                        <span class="wr__name">{{ draft.weapon_name }}</span>
                        @if (draft.locked) {
                          <span class="wr__state">
                            <app-icon name="lock" size="0.75rem" />
                            {{ isManage() ? t('weapons.locked') : t('weapons.lockedByOfficer') }}
                          </span>
                        } @else if (draft.proficiency === null) {
                          <span class="wr__state">{{ t('weapons.notDeclared') }}</span>
                        }
                      </div>

                      @if (draft.proficiency !== null || canEditRow(draft)) {
                        <fieldset class="wr__levels" [disabled]="!canEditRow(draft)">
                          <legend class="sr-only">
                            {{ t('weapons.proficiency.level', { name: draft.weapon_name }) }}
                          </legend>
                          @for (level of proficiencies; track level) {
                            <label [class]="levelClass(level, draft.proficiency === level)">
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
                        <button
                          type="button"
                          class="wr__lock"
                          [attr.aria-pressed]="draft.locked"
                          [attr.aria-label]="t('weapons.lockFor', { name: draft.weapon_name })"
                          (click)="toggleLock(draft.weapon_key)"
                        >
                          <app-icon name="lock" size="0.875rem" />
                          {{ t('weapons.lockToggle') }}
                        </button>
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

        @if (editable()) {
          <div class="wr__footer">
            <span class="wr__dirty" role="status">{{ dirty() ? t('weapons.unsaved') : '' }}</span>
            @if (dirty()) {
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                [disabled]="saving()"
                (click)="discard()"
              >
                {{ t('weapons.discard') }}
              </button>
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
  protected readonly proficiencies = WEAPON_PROFICIENCIES;
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  /** Polite live-region text for changes that have no other visible confirmation. */
  protected readonly announcement = signal('');
  private readonly catalog = signal<readonly OpenAlbionItem[]>([]);
  private readonly saved = signal<readonly WeaponDraft[]>([]);
  protected readonly drafts = signal<readonly WeaponDraft[]>([]);
  private readonly brokenIcons = signal<ReadonlySet<string>>(new Set());

  protected readonly isManage = computed(() => this.mode() === 'manage');
  protected readonly dirty = computed(() => weaponDraftsChanged(this.saved(), this.drafts()));
  protected readonly groups = computed(() => groupWeaponDrafts(this.drafts()));
  protected readonly summary = computed(() => summarizeWeaponDrafts(this.drafts()));
  private readonly options = computed(() => weaponOptionsFromCatalog(this.catalog()));

  protected readonly pickerOptions = computed<SearchableSelectOption[]>(() => {
    const taken = new Set(this.drafts().map((draft) => draft.weapon_key));
    return this.options()
      .filter((option) => !taken.has(option.key))
      .map((option) => ({
        id: option.key,
        label: option.name,
        group: this.translate.t(weaponFamilyLabelKey(option.family) as TranslationKey),
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

  protected tone(level: WeaponProficiency): 'success' | 'info' | 'neutral' {
    return PROFICIENCY_TONE[level];
  }

  protected familyLabel(family: WeaponFamilyId): TranslationKey {
    return weaponFamilyLabelKey(family) as TranslationKey;
  }

  protected groupId(family: WeaponFamilyId): string {
    return `weapon-roster-${this.uid}-${family}`;
  }

  protected levelClass(level: WeaponProficiency, selected: boolean): string {
    return `wr__level wr__level--${level}${selected ? ' wr__level--on' : ''}`;
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
    this.announcement.set(this.t('weapons.added', { name: option.name }));
  }

  protected setLevel(weaponKey: string, level: WeaponProficiency): void {
    this.patch(weaponKey, { proficiency: level });
  }

  protected toggleLock(weaponKey: string): void {
    const current = this.drafts().find((draft) => draft.weapon_key === weaponKey);
    if (current) this.patch(weaponKey, { locked: !current.locked });
  }

  protected removeWeapon(weaponKey: string): void {
    const removed = this.drafts().find((draft) => draft.weapon_key === weaponKey);
    this.drafts.update((current) => current.filter((draft) => draft.weapon_key !== weaponKey));
    if (removed) this.announcement.set(this.t('weapons.removed', { name: removed.weapon_name }));
  }

  protected discard(): void {
    this.drafts.set(this.saved());
    this.announcement.set(this.t('weapons.discarded'));
  }

  private patch(weaponKey: string, change: Partial<WeaponDraft>): void {
    this.drafts.update((current) =>
      current.map((draft) => (draft.weapon_key === weaponKey ? { ...draft, ...change } : draft)),
    );
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
