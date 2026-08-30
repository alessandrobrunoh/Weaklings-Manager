import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { validateBuildName } from '../../shared/validation/build-validation';

import type {
  BuildRole,
  BuildSummary,
  CompCategoryView,
  CompDetail,
  CompPerformanceView,
  CompSummary,
  CreateCompRequest,
  OpponentPerformanceView,
  PaginatedData,
  UpdateCompRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

const ROLES: BuildRole[] = ['healer', 'support', 'dps', 'tank', 'battle_mount', 'brawler'];

const ROLE_LABELS: Record<BuildRole, string> = {
  healer: 'Healer',
  support: 'Support',
  dps: 'DPS',
  tank: 'Tank',
  battle_mount: 'Battle Mount',
  brawler: 'Brawler',
};

/**
 * Composition detail page.
 *
 * Shows aggregated event/battle analytics and lets officers fully edit the
 * composition (metadata, builds, quantities) without leaving the page. Built
 * on top of the existing `/api/comps/{id}` and `/performance` endpoints.
 *
 * @example
 * ```ts
 * routes.push({ path: 'comps/:compId', loadComponent: () => import('./comp-detail').then(m => m.CompDetailPage) });
 * ```
 */
@Component({
  selector: 'app-comp-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeader, PageStack, EmptyState, ErrorState, Loading, Dialog],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (comp(); as current) {
      <app-page-header
        [title]="current.name"
        [subtitle]="current.category_name || t('comps.noCategory')"
      >
        <div class="flex flex-wrap gap-2">
          <a class="btn btn--ghost" routerLink="/comps">← {{ t('comps.title') }}</a>
          @if (parentComp(); as parent) {
            <a class="btn btn--outline" [routerLink]="['/comps', parent.id]">
              ↑ {{ parent.name }}
            </a>
          }
          @if (canManage() && mode() === 'view') {
            <button
              type="button"
              class="btn btn--outline"
              (click)="enterEdit()"
              [disabled]="saving()"
            >
              {{ t('common.edit') }}
            </button>
            <button
              type="button"
              class="btn btn--tonal"
              (click)="cloneComp()"
              [disabled]="saving()"
            >
              {{ t('common.clone') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              (click)="askDeleteComp()"
              [disabled]="saving()"
            >
              {{ t('common.delete') }}
            </button>
          }
        </div>
      </app-page-header>

      <app-page-stack>
        @if (mode() === 'edit' && canManage()) {
          <form class="card grid gap-4 p-5" (submit)="saveEdit($event)">
            <div class="grid gap-4 md:grid-cols-2">
              <label>
                <span class="label">{{ t('common.name') }}</span>
                <input
                  class="input"
                  type="text"
                  [value]="editName()"
                  (input)="onEditNameChange($event)"
                />
              </label>
              <label>
                <span class="label">{{ t('common.category') }}</span>
                <select
                  class="select"
                  [value]="editCategoryId()"
                  (change)="onEditCategoryChange($event)"
                >
                  <option value="">{{ t('comps.noCategory') }}</option>
                  @for (category of compCategories(); track category.id) {
                    <option [value]="category.id">{{ category.name }}</option>
                  }
                </select>
              </label>
            </div>
            <label>
              <span class="label">{{ t('common.description') }}</span>
              <textarea
                class="textarea"
                rows="3"
                [value]="editDescription()"
                (input)="onEditDescriptionChange($event)"
              ></textarea>
            </label>
            <label>
              <span class="label">{{ t('comps.parent') }}</span>
              <select class="select" [value]="editParentId()" (change)="onEditParentChange($event)">
                <option value="">{{ t('comps.noParent') }}</option>
                @for (sibling of availableParents(); track sibling.id) {
                  <option [value]="sibling.id">{{ sibling.name }}</option>
                }
              </select>
            </label>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost" (click)="cancelEdit()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        }

        <section class="card grid gap-4 p-5" [attr.aria-label]="t('comps.builds')">
          <header class="flex items-center justify-between gap-3">
            <h2 class="text-lg font-semibold" style="color: var(--color-text)">
              {{ t('comps.builds') }} ({{ current.builds.length }}) · {{ current.total_quantity }}
            </h2>
            @if (canManage() && mode() === 'edit') {
              <button type="button" class="btn btn--outline" (click)="toggleAddBuild()">
                {{ addingBuild() ? t('common.close') : t('comps.addBuild') }}
              </button>
            }
          </header>

          @if (addingBuild() && canManage() && mode() === 'edit') {
            <form class="surface grid gap-3 p-4" (submit)="addBuild($event)">
              <div class="grid gap-3 sm:grid-cols-[1fr_8rem_auto]">
                <select class="select" [value]="newBuildId()" (change)="onNewBuildChange($event)">
                  <option value="">{{ t('comps.selectBuild') }}</option>
                  @for (build of buildOptions(); track build.id) {
                    <option [value]="build.id">
                      {{ build.name }} — {{ roleLabel(build.role) }} —
                      {{ build.category_name || t('comps.noCategory') }}
                    </option>
                  }
                </select>
                <input
                  class="input"
                  type="number"
                  min="1"
                  [value]="newBuildQuantity()"
                  (input)="onNewBuildQtyChange($event)"
                />
                <button type="submit" class="btn btn--primary" [disabled]="saving()">
                  {{ t('common.add') }}
                </button>
              </div>
            </form>
          }

          @if (current.builds.length === 0) {
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ t('comps.noBuilds') }}
            </p>
          } @else {
            <ul class="grid gap-2">
              @for (entry of current.builds; track entry.build_id) {
                <li
                  class="flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2"
                  style="background-color: var(--color-surface-1)"
                >
                  <div class="flex items-center gap-3">
                    <a
                      class="font-medium hover:underline"
                      [routerLink]="['/comps', 'builds', entry.build_id]"
                    >
                      {{ entry.build.name }}
                    </a>
                    <span class="chip">{{ roleLabel(entry.build.role) }}</span>
                    <span class="text-xs" style="color: var(--color-text-secondary)">
                      {{ entry.build.category_name || t('comps.noCategory') }}
                    </span>
                  </div>
                  <div class="flex items-center gap-2">
                    @if (mode() === 'edit' && editingBuildId() === entry.build_id) {
                      <input
                        class="input"
                        type="number"
                        min="1"
                        style="width: 6rem"
                        [value]="editingBuildQty()"
                        (input)="onEditingBuildQtyChange($event)"
                      />
                      <button
                        type="button"
                        class="btn btn--primary btn--sm"
                        (click)="saveBuildQty(entry.build_id)"
                        [disabled]="saving()"
                      >
                        {{ t('common.save') }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        (click)="cancelEditBuild()"
                      >
                        {{ t('common.cancel') }}
                      </button>
                    } @else {
                      <span class="chip">x{{ entry.quantity }}</span>
                      @if (canManage() && mode() === 'edit') {
                        <button
                          type="button"
                          class="btn btn--outline btn--sm"
                          (click)="startEditBuild(entry.build_id, entry.quantity)"
                        >
                          {{ t('common.edit') }}
                        </button>
                        <button
                          type="button"
                          class="btn btn--danger btn--sm"
                          (click)="removeBuild(entry.build_id)"
                          [disabled]="saving()"
                        >
                          {{ t('common.delete') }}
                        </button>
                      }
                    }
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        @if (performance(); as perf) {
          <section class="card grid gap-4 p-5" [attr.aria-label]="t('comps.performance')">
            <header>
              <h2 class="text-lg font-semibold" style="color: var(--color-text)">
                {{ t('comps.performance') }}
              </h2>
              <p class="text-sm" style="color: var(--color-text-secondary)">
                Aggregated from {{ perf.events_with_battles }} event(s) with linked battles.
              </p>
            </header>
            @if (perf.stats.total_battles === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">
                No battles linked to events using this comp yet.
              </p>
            } @else {
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Battles
                  </p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ perf.stats.total_battles }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">W/L</p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ perf.stats.wins }}-{{ perf.stats.losses }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Win rate
                  </p>
                  <p class="text-xl font-bold" [style.color]="winRateColor(perf.stats.win_rate)">
                    {{ formatPercent(perf.stats.win_rate) }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">K/D</p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ formatRatio(perf.stats.kill_death_ratio) }}
                  </p>
                  <p class="text-xs" style="color: var(--color-text-secondary)">
                    {{ perf.stats.total_kills }}/{{ perf.stats.total_deaths }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Kill fame
                  </p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ formatNumber(perf.stats.total_kill_fame) }}
                  </p>
                </div>
              </div>

              @if (perf.stats.top_opponents.length > 0) {
                <!-- Shared .table class (thead/hover/borders come from the
                   design system) inside a horizontal-scroll wrapper, matching
                   every other table in the app — this one used to clip its
                   rightmost columns with overflow-hidden instead of
                   scrolling them into view on narrow screens. -->
                <div class="mt-2 overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="text-left">Opponent</th>
                        <th class="text-right">Battles</th>
                        <th class="text-right">W-L</th>
                        <th class="text-right">Win %</th>
                        <th class="text-right">Our fame</th>
                        <th class="text-right">Their fame</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (opponent of perf.stats.top_opponents; track opponentKey(opponent)) {
                        <tr>
                          <td>{{ opponent.guild_name }}</td>
                          <td class="text-right">{{ opponent.battles }}</td>
                          <td class="text-right">{{ opponent.wins }}-{{ opponent.losses }}</td>
                          <td
                            class="text-right"
                            [style.color]="winRateColor(opponentBattlesWinRate(opponent))"
                          >
                            {{ formatPercent(opponentBattlesWinRate(opponent)) }}
                          </td>
                          <td class="text-right">{{ formatNumber(opponent.guild_kill_fame) }}</td>
                          <td class="text-right">
                            {{ formatNumber(opponent.opponent_kill_fame) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            }
          </section>
        }
      </app-page-stack>

      @if (pendingDelete()) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeDelete()">
          <p>{{ t('comps.delete.confirm') }}</p>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">{{ current.name }}</p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeDelete()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              [disabled]="saving()"
              (click)="deleteComp()"
            >
              {{ t('common.delete') }}
            </button>
          </div>
        </app-dialog>
      }
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load(compId)"
      />
    } @else if (!loading()) {
      <app-empty-state [message]="t('comps.notFound')" icon="package" />
    }
  `,
})
export class CompDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly comp = signal<CompDetail | null>(null);
  protected readonly parentComp = signal<CompSummary | null>(null);
  protected readonly performance = signal<CompPerformanceView | null>(null);
  protected readonly compCategories = signal<CompCategoryView[]>([]);
  protected readonly buildOptions = signal<BuildSummary[]>([]);
  protected readonly compSummaries = signal<CompSummary[]>([]);

  protected readonly mode = signal<'view' | 'edit'>('view');
  protected readonly pendingDelete = signal(false);
  protected readonly editName = signal('');
  protected readonly editDescription = signal('');
  protected readonly editCategoryId = signal('');
  protected readonly editParentId = signal('');

  protected readonly addingBuild = signal(false);
  protected readonly newBuildId = signal('');
  protected readonly newBuildQuantity = signal(1);

  protected readonly editingBuildId = signal<number | null>(null);
  protected readonly editingBuildQty = signal(1);

  protected readonly t = (key: TranslationKey) => this.translate.t(key);

  protected readonly canManage = computed(() => this.auth.hasPermission('comps.comps.manage'));
  protected readonly availableParents = computed(() =>
    this.compSummaries().filter((sibling) => sibling.id !== this.comp()?.id),
  );

  protected readonly compId = Number(this.route.snapshot.paramMap.get('compId'));

  constructor() {
    void this.load(this.compId);
  }

  protected roleLabel(role: BuildRole): string {
    return ROLE_LABELS[role] ?? role;
  }

  protected enterEdit(): void {
    const current = this.comp();
    if (!current) {
      return;
    }
    this.editName.set(current.name);
    this.editDescription.set(current.description ?? '');
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editParentId.set(current.parent_id ? String(current.parent_id) : '');
    this.mode.set('edit');
    void this.loadEditOptions();
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.addingBuild.set(false);
    this.cancelEditBuild();
    void this.load(this.compId);
  }

  protected toggleAddBuild(): void {
    this.addingBuild.update((value) => !value);
    this.newBuildId.set('');
    this.newBuildQuantity.set(1);
  }

  protected onEditNameChange(event: Event): void {
    this.editName.set((event.target as HTMLInputElement).value);
  }

  protected onEditDescriptionChange(event: Event): void {
    this.editDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onEditCategoryChange(event: Event): void {
    this.editCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditParentChange(event: Event): void {
    this.editParentId.set((event.target as HTMLSelectElement).value);
  }

  protected onNewBuildChange(event: Event): void {
    this.newBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected onNewBuildQtyChange(event: Event): void {
    this.newBuildQuantity.set(Number((event.target as HTMLInputElement).value) || 1);
  }

  protected onEditingBuildQtyChange(event: Event): void {
    this.editingBuildQty.set(Number((event.target as HTMLInputElement).value) || 1);
  }

  protected startEditBuild(buildId: number, currentQty: number): void {
    this.editingBuildId.set(buildId);
    this.editingBuildQty.set(currentQty);
  }

  protected cancelEditBuild(): void {
    this.editingBuildId.set(null);
  }

  protected async saveEdit(event: Event): Promise<void> {
    event.preventDefault();
    const comp = this.comp();
    if (!comp) {
      return;
    }

    // Validated even when unchanged: the previous version only applied the
    // name `if (editName())`, so clearing the field was silently ignored
    // instead of rejected, and the save still reported success.
    const nameError = validateBuildName(this.editName(), {
      existingNames: [],
      currentName: comp.name,
    });
    if (nameError) {
      this.toasts.error(nameError.message);
      return;
    }

    const request: UpdateCompRequest = {};
    const name = this.editName().trim();
    if (name !== comp.name) request.name = name;
    // Compared against the current value rather than tested for truthiness,
    // so an emptied description actually clears instead of being dropped.
    if (this.editDescription() !== (comp.description ?? '')) {
      request.description = this.editDescription();
    }
    const categoryId = this.editCategoryId() ? Number(this.editCategoryId()) : undefined;
    if (categoryId && categoryId !== comp.category_id) request.category_id = categoryId;
    const parentId = this.editParentId() ? Number(this.editParentId()) : null;
    if ((parentId ?? null) !== (comp.parent_id ?? null)) {
      request.parent_id = parentId ?? undefined;
    }

    if (Object.keys(request).length === 0) {
      this.mode.set('view');
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<CompDetail>(`api/comps/${comp.id}`, request));
      this.mode.set('view');
      this.addingBuild.set(false);
      this.cancelEditBuild();
      await this.load(this.compId);
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async cloneComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const request: CreateCompRequest = {
        name: `${comp.name} (clone)`,
        category_id: comp.category_id,
        builds: comp.builds.map((entry) => ({
          build_id: entry.build_id,
          quantity: entry.quantity,
        })),
        parent_id: comp.id,
      };
      const created = await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      this.toasts.success('Composition cloned');
      await this.router.navigate(['/comps', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askDeleteComp(): void {
    this.pendingDelete.set(true);
  }

  protected closeDelete(): void {
    this.pendingDelete.set(false);
  }

  protected async deleteComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/comps/${comp.id}`));
      this.pendingDelete.set(false);
      this.toasts.success(this.t('common.delete'));
      await this.router.navigate(['/comps']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async addBuild(event: Event): Promise<void> {
    event.preventDefault();
    const comp = this.comp();
    const buildId = Number(this.newBuildId());
    if (!comp || !buildId) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<CompDetail>(`api/comps/${comp.id}/builds`, {
          build_id: buildId,
          quantity: this.newBuildQuantity(),
        }),
      );
      this.comp.set(updated);
      this.toggleAddBuild();
      this.toasts.success('Build added');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveBuildQty(buildId: number): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<CompDetail>(`api/comps/${comp.id}/builds/${buildId}`, {
          quantity: this.editingBuildQty(),
        }),
      );
      this.comp.set(updated);
      this.cancelEditBuild();
      this.toasts.success('Quantity updated');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async removeBuild(buildId: number): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<CompDetail>(`api/comps/${comp.id}/builds/${buildId}`),
      );
      this.comp.set(updated ?? null);
      this.toasts.success('Build removed');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected opponentKey(opponent: OpponentPerformanceView): string {
    return opponent.guild_id ?? opponent.guild_name;
  }

  protected opponentBattlesWinRate(opponent: OpponentPerformanceView): number {
    if (opponent.battles === 0) {
      return 0;
    }
    return (opponent.wins / opponent.battles) * 100;
  }

  protected winRateColor(rate: number): string {
    if (rate >= 60) return 'var(--color-success)';
    if (rate < 40) return 'var(--color-danger)';
    return 'var(--color-text)';
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }

  protected formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  protected formatRatio(value: number): string {
    return value.toFixed(2);
  }

  private async loadEditOptions(): Promise<void> {
    const [categories, builds, summaries] = await Promise.all([
      firstValueFrom(this.api.get<CompCategoryView[]>('api/comps/comp-categories')).catch(() => []),
      firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
        }),
      ).catch(() => ({ items: [] as BuildSummary[] })),
      firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
        }),
      ).catch(() => ({ items: [] as CompSummary[] })),
    ]);
    this.compCategories.set(categories);
    this.buildOptions.set(builds.items);
    this.compSummaries.set(summaries.items);
  }

  protected async load(compId: number): Promise<void> {
    if (!Number.isFinite(compId) || compId <= 0) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [comp, performance] = await Promise.all([
        firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`)),
        firstValueFrom(this.api.get<CompPerformanceView>(`api/comps/${compId}/performance`)).catch(
          () => null,
        ),
      ]);
      this.comp.set(comp);
      this.performance.set(performance);
      if (comp.parent_id) {
        const parent = await firstValueFrom(
          this.api.get<CompSummary>(`api/comps/${comp.parent_id}`),
        ).catch(() => null);
        this.parentComp.set(parent);
      } else {
        this.parentComp.set(null);
      }
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
