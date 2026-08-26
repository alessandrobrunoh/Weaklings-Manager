import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdjustProgressionRequest,
  PaginatedData,
  ProgressionLeaderboardEntry,
  ProgressionMeView,
  Role,
  UserProfile,
  WarnView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

/** Page size requested when bulk-loading the roster for client-side filtering. */
const ROSTER_LOAD_LIMIT = 1000;

/** Roster row with season XP merged from a single leaderboard request. */
interface MemberRow extends UserProfile {
  level: number;
  xp: number;
  multiplier: number;
}

interface AdjustDraft {
  addXp: string;
  setLevel: string;
  setMultiplier: string;
  expiresAt: string;
  reason: string;
}

function emptyAdjustDraft(): AdjustDraft {
  return { addXp: '', setLevel: '', setMultiplier: '', expiresAt: '', reason: '' };
}

function asPaginated<T>(data: PaginatedData<T> | T[]): T[] {
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * Guild member directory.
 *
 * Drives the participant picker used elsewhere (splits, events), but exposed
 * here as a browsable list. Loads the whole roster once and delegates search,
 * sort, filter and pagination to `DataTable`, keeping round-trips off the
 * critical path for the common typing-in-the-search-box interaction.
 *
 * Season XP is joined from one leaderboard request (limit 1000) mapped by
 * `user_id`. Officers can open a drawer on a row to adjust XP/level/multiplier.
 */
@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, DataTable, DataTableCell, Icon, Loading],
  template: `
    <app-page-header
      [title]="t('users.title')"
      [subtitle]="t('users.subtitle')"
      [actions]="false"
    />

    <app-data-table
      [columns]="columns"
      [rows]="users()"
      [loading]="loading()"
      [error]="loadFailed()"
      (retry)="load()"
      [trackBy]="trackById"
      [pageSize]="10"
      emptyIcon="users"
      [rowClickable]="canAdjust()"
      (rowClick)="openMember($event)"
    >
      <ng-template dataTableCell="username" let-row>
        <span style="font-weight: 500">{{ row.username }}</span>
      </ng-template>
      <ng-template dataTableCell="email" let-row>
        <span style="color: var(--color-text-secondary)">{{ row.email }}</span>
      </ng-template>
      <ng-template dataTableCell="role" let-row>
        <span class="chip" [class]="roleChip(row.role)">{{ row.role }}</span>
      </ng-template>
      <ng-template dataTableCell="multiplier" let-row>
        ×{{ formatMultiplier(row.multiplier) }}
      </ng-template>
    </app-data-table>

    @if (selected(); as member) {
      <div class="users-drawer" role="dialog" aria-modal="true" [attr.aria-label]="t('users.adjust.title')">
        <button type="button" class="users-drawer__backdrop" (click)="closeMember()" [attr.aria-label]="t('common.close')"></button>
        <aside class="users-drawer__panel card p-5">
          <header class="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold" style="color: var(--color-text)">
                {{ member.username }}
              </h2>
              <p class="text-sm" style="color: var(--color-text-secondary)">
                {{ t('users.adjust.title') }}
              </p>
            </div>
            <button type="button" class="btn btn--ghost" (click)="closeMember()">
              <app-icon name="close" size="1rem" />
            </button>
          </header>

          @if (drawerLoading()) {
            <app-loading [label]="t('common.loading')" />
          } @else {
            @if (selectedProgression(); as xp) {
              <dl class="mb-4 grid grid-cols-2 gap-y-1.5 text-sm">
                <dt style="color: var(--color-text-secondary)">{{ t('users.level') }}</dt>
                <dd class="text-right font-semibold">{{ xp.level }}</dd>
                <dt style="color: var(--color-text-secondary)">{{ t('users.xp') }}</dt>
                <dd class="text-right font-semibold">{{ formatAmount(xp.xp) }}</dd>
                <dt style="color: var(--color-text-secondary)">{{ t('users.multiplier') }}</dt>
                <dd class="text-right font-semibold">×{{ formatMultiplier(xp.multiplier) }}</dd>
              </dl>
            }

            <form class="grid gap-3" (submit)="onAdjustSubmit($event)">
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('users.adjust.hint') }}
              </p>
              <label>
                <span class="label">{{ t('users.adjust.addXp') }}</span>
                <input
                  class="input"
                  type="number"
                  [value]="draft().addXp"
                  (input)="updateDraft('addXp', $event)"
                />
              </label>
              <label>
                <span class="label">{{ t('users.adjust.setLevel') }}</span>
                <input
                  class="input"
                  type="number"
                  min="1"
                  [value]="draft().setLevel"
                  (input)="updateDraft('setLevel', $event)"
                />
              </label>
              <label>
                <span class="label">{{ t('users.adjust.setMultiplier') }}</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  [value]="draft().setMultiplier"
                  (input)="updateDraft('setMultiplier', $event)"
                />
              </label>
              <label>
                <span class="label">{{ t('users.adjust.expires') }}</span>
                <input
                  class="input"
                  type="datetime-local"
                  [value]="draft().expiresAt"
                  (input)="updateDraft('expiresAt', $event)"
                />
              </label>
              <label>
                <span class="label">{{ t('users.adjust.reason') }}</span>
                <input
                  class="input"
                  required
                  [value]="draft().reason"
                  (input)="updateDraft('reason', $event)"
                />
              </label>
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('users.adjust.submit') }}
              </button>
            </form>

            @if (canViewWarns()) {
              <section class="mt-5">
                <h3 class="mb-2 text-sm font-semibold" style="color: var(--color-text)">
                  {{ t('users.warns.title') }}
                </h3>
                @if (selectedWarns().length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    {{ t('common.empty') }}
                  </p>
                } @else {
                  <ul class="grid gap-2">
                    @for (warn of selectedWarns(); track warn.id) {
                      <li class="surface p-3 text-sm">
                        <div class="flex items-center justify-between gap-2">
                          <span class="chip" [class]="severityChip(warn.severity)">{{ warn.severity }}</span>
                          @if (warn.revoked_at) {
                            <span class="chip">{{ t('warns.revoked') }}</span>
                          }
                        </div>
                        <p class="mt-2">{{ warn.reason }}</p>
                        <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
                          {{ formatDate(warn.created_at) }}
                        </p>
                      </li>
                    }
                  </ul>
                }
              </section>
            }
          }
        </aside>
      </div>
    }
  `,
  styles: `
    .users-drawer {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: flex;
      justify-content: flex-end;
    }
    .users-drawer__backdrop {
      position: absolute;
      inset: 0;
      border: 0;
      background: rgba(0, 0, 0, 0.45);
      cursor: pointer;
    }
    .users-drawer__panel {
      position: relative;
      z-index: 1;
      width: min(26rem, 100%);
      height: 100%;
      overflow-y: auto;
      border-radius: 0;
    }
  `,
})
export class Users {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly users = signal<MemberRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly drawerLoading = signal(false);
  protected readonly saving = signal(false);
  protected readonly selected = signal<MemberRow | null>(null);
  protected readonly selectedProgression = signal<ProgressionMeView | null>(null);
  protected readonly selectedWarns = signal<WarnView[]>([]);
  protected readonly draft = signal<AdjustDraft>(emptyAdjustDraft());
  protected readonly trackById = (user: MemberRow): unknown => user.id;

  protected readonly canAdjust = computed(
    () =>
      this.auth.hasRole('Officer', 'Admin', 'SuperAdmin') ||
      this.auth.hasPermission('progression.adjust'),
  );

  protected readonly canViewWarns = computed(() => this.auth.hasPermission('warns.view'));

  protected readonly columns: readonly DataTableColumn<MemberRow>[] = [
    {
      key: 'username',
      label: 'common.username',
      sortable: true,
      searchable: true,
      accessor: (user) => user.username,
      comparator: (a, b) => a.username.localeCompare(b.username),
    },
    {
      key: 'email',
      label: 'common.email',
      sortable: true,
      searchable: true,
      accessor: (user) => user.email,
      comparator: (a, b) => a.email.localeCompare(b.email),
    },
    {
      key: 'role',
      label: 'common.role',
      sortable: true,
      accessor: (user) => user.role,
      comparator: (a, b) => a.role.localeCompare(b.role),
      filterOptions: [
        { value: 'SuperAdmin', label: 'SuperAdmin' },
        { value: 'Admin', label: 'Admin' },
        { value: 'Officer', label: 'Officer' },
        { value: 'Member', label: 'Member' },
      ],
    },
    {
      key: 'level',
      label: 'users.level',
      sortable: true,
      accessor: (user) => user.level,
      comparator: (a, b) => a.level - b.level,
      align: 'right',
    },
    {
      key: 'xp',
      label: 'users.xp',
      sortable: true,
      accessor: (user) => user.xp,
      comparator: (a, b) => a.xp - b.xp,
      align: 'right',
    },
    {
      key: 'multiplier',
      label: 'users.multiplier',
      sortable: true,
      accessor: (user) => user.multiplier,
      comparator: (a, b) => a.multiplier - b.multiplier,
      align: 'right',
    },
  ];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected roleChip(role: Role): string {
    if (role === 'SuperAdmin') {
      return 'chip chip--error';
    }
    if (role === 'Admin') {
      return 'chip chip--warning';
    }
    if (role === 'Officer') {
      return 'chip chip--success';
    }
    return 'chip';
  }

  protected severityChip(severity: WarnView['severity']): string {
    if (severity === 'strike') {
      return 'chip chip--error';
    }
    if (severity === 'warn') {
      return 'chip chip--warning';
    }
    return 'chip';
  }

  protected formatAmount(value: number): string {
    return new Intl.NumberFormat().format(value);
  }

  protected formatMultiplier(value: string | number): string {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return String(value);
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  protected formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected updateDraft(field: keyof AdjustDraft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((current) => ({ ...current, [field]: value }));
  }

  protected closeMember(): void {
    this.selected.set(null);
    this.selectedProgression.set(null);
    this.selectedWarns.set([]);
    this.draft.set(emptyAdjustDraft());
  }

  protected async openMember(row: MemberRow): Promise<void> {
    if (!this.canAdjust()) {
      return;
    }
    this.selected.set(row);
    this.draft.set(emptyAdjustDraft());
    this.drawerLoading.set(true);
    try {
      const snapshot = await firstValueFrom(
        this.api.get<ProgressionMeView>(`api/progression/users/${row.id}`),
      );
      this.selectedProgression.set(snapshot);
      if (this.canViewWarns()) {
        const warns = await firstValueFrom(
          this.api.get<PaginatedData<WarnView> | WarnView[]>('api/warns', {
            user_id: row.id,
            page: 1,
            limit: 50,
          }),
        );
        this.selectedWarns.set(asPaginated(warns));
      }
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.drawerLoading.set(false);
    }
  }

  protected async onAdjustSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const member = this.selected();
    if (!member || this.saving()) {
      return;
    }
    const draft = this.draft();
    const reason = draft.reason.trim();
    if (!reason) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const body: AdjustProgressionRequest = { reason };
    if (draft.addXp.trim() !== '') {
      body.add_xp = Number(draft.addXp);
    }
    if (draft.setLevel.trim() !== '') {
      body.set_level = Number(draft.setLevel);
    }
    if (draft.setMultiplier.trim() !== '') {
      body.set_multiplier = Number(draft.setMultiplier);
    }
    if (draft.expiresAt.trim() !== '') {
      body.multiplier_expires_at = new Date(draft.expiresAt).toISOString();
    }
    if (
      body.add_xp === undefined &&
      body.set_level === undefined &&
      body.set_multiplier === undefined
    ) {
      this.toasts.error(this.t('users.adjust.hint'));
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<ProgressionMeView>(`api/progression/users/${member.id}/adjust`, body),
      );
      this.selectedProgression.set(updated);
      const nextMultiplier = Number(updated.multiplier);
      this.users.update((rows) =>
        rows.map((row) =>
          row.id === member.id
            ? {
                ...row,
                level: updated.level,
                xp: updated.xp,
                multiplier: Number.isFinite(nextMultiplier) ? nextMultiplier : 1,
              }
            : row,
        ),
      );
      this.draft.set(emptyAdjustDraft());
      this.toasts.success(this.t('users.adjust.success'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [data, board] = await Promise.all([
        firstValueFrom(
          this.api.get<{ items: UserProfile[]; total_items: number }>('api/users', {
            page: 1,
            limit: ROSTER_LOAD_LIMIT,
          }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<ProgressionLeaderboardEntry>>('api/progression/leaderboard', {
            page: 1,
            limit: ROSTER_LOAD_LIMIT,
          }),
        ).catch(
          (): PaginatedData<ProgressionLeaderboardEntry> => ({
            items: [],
            total_items: 0,
            total_pages: 0,
            current_page: 1,
            limit: ROSTER_LOAD_LIMIT,
          }),
        ),
      ]);
      const byUser = new Map((board.items ?? []).map((row) => [row.user_id, row]));
      this.users.set(
        data.items.map((user) => {
          const xp = byUser.get(user.id);
          return {
            ...user,
            level: xp?.level ?? 1,
            xp: xp?.xp ?? 0,
            multiplier: 1,
          };
        }),
      );
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
