import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  CreateWarnRequest,
  PaginatedData,
  UserProfile,
  WarnEscalationView,
  WarnSeverity,
  WarnView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../shared/components/page-header/page-header';

const LOAD_LIMIT = 1000;

interface IssueDraft {
  userId: string;
  reason: string;
  severity: WarnSeverity;
  multiplier: string;
  expiresAt: string;
}

function emptyIssueDraft(): IssueDraft {
  return { userId: '', reason: '', severity: 'warn', multiplier: '', expiresAt: '' };
}

function asPaginated<T>(data: PaginatedData<T> | T[]): T[] {
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * Guild warn register and open-escalation queue.
 *
 * Officers issue and revoke warns, and acknowledge threshold escalations after
 * a manual Albion/Discord kick. The page is role-gated at the route.
 */
@Component({
  selector: 'app-warns',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DataTable, DataTableCell, EmptyState, PageHeader],
  template: `
    <app-page-header [title]="t('warns.title')" [subtitle]="t('warns.subtitle')">
      @if (canIssue()) {
        <button type="button" class="btn btn--primary" (click)="toggleIssueForm()">
          {{ showIssueForm() ? t('common.close') : t('warns.issue') }}
        </button>
      }
    </app-page-header>

    <section class="card mb-6 p-6">
      <h2 class="eyebrow mb-3">
        {{ t('warns.escalations') }}
      </h2>
      @if (loading()) {
        <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.loading') }}</p>
      } @else if (escalations().length === 0) {
        <app-empty-state icon="alert" [message]="t('warns.escalations.empty')" />
      } @else {
        <ul class="grid gap-3">
          @for (row of escalations(); track row.id) {
            <li class="surface flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p class="font-semibold" style="color: var(--color-text)">
                  {{ displayName(row.user_id, row.username) }}
                </p>
                <p class="text-sm" style="color: var(--color-text-secondary)">
                  {{ t('warns.count') }}: {{ row.warn_count_at_time }}
                  · {{ t('admin.progression.warnThreshold') }}: {{ row.threshold_at_time }}
                  · {{ row.opened_at | date: 'short' }}
                </p>
              </div>
              @if (!row.acknowledged_at) {
                <button
                  type="button"
                  class="btn btn--primary"
                  [disabled]="ackingId() === row.id"
                  (click)="ack(row.id)"
                >
                  {{ t('warns.ack') }}
                </button>
              } @else {
                <span class="chip chip--success">{{ t('warns.acked') }}</span>
              }
            </li>
          }
        </ul>
      }
    </section>

    @if (showIssueForm()) {
      <form class="card mb-6 grid gap-4 p-5 sm:grid-cols-2" (submit)="onIssueSubmit($event)">
        <label>
          <span class="label">{{ t('warns.user') }}</span>
          <select class="select" [value]="issueDraft().userId" (change)="updateIssue('userId', $event)" required>
            <option value="">{{ t('common.none') }}</option>
            @for (user of members(); track user.id) {
              <option [value]="user.id">{{ user.username }}</option>
            }
          </select>
        </label>
        <label>
          <span class="label">{{ t('warns.severity') }}</span>
          <select class="select" [value]="issueDraft().severity" (change)="updateIssue('severity', $event)">
            <option value="note">{{ t('warns.severity.note') }}</option>
            <option value="warn">{{ t('warns.severity.warn') }}</option>
            <option value="strike">{{ t('warns.severity.strike') }}</option>
          </select>
        </label>
        <label class="sm:col-span-2">
          <span class="label">{{ t('warns.reason') }}</span>
          <input
            class="input"
            required
            [value]="issueDraft().reason"
            (input)="updateIssue('reason', $event)"
          />
        </label>
        <label>
          <span class="label">{{ t('warns.multiplier') }} ({{ t('common.optional') }})</span>
          <input
            class="input"
            type="number"
            min="0"
            max="5"
            step="0.1"
            [value]="issueDraft().multiplier"
            (input)="updateIssue('multiplier', $event)"
          />
        </label>
        <label>
          <span class="label">{{ t('warns.expires') }}</span>
          <input
            class="input"
            type="datetime-local"
            [value]="issueDraft().expiresAt"
            (input)="updateIssue('expiresAt', $event)"
          />
        </label>
        <div class="flex justify-end gap-2 sm:col-span-2">
          <button type="button" class="btn btn--ghost" (click)="toggleIssueForm()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" [disabled]="saving()">
            {{ t('warns.issue') }}
          </button>
        </div>
      </form>
    }

    <app-data-table
      [columns]="columns()"
      [rows]="warns()"
      [loading]="loading()"
      [error]="loadFailed()"
      (retry)="load()"
      [trackBy]="trackById"
      [pageSize]="20"
      emptyIcon="alert"
    >
      <ng-template dataTableCell="user" let-row>
        <span style="font-weight: 500">{{ displayName(row.user_id, row.username) }}</span>
      </ng-template>
      <ng-template dataTableCell="severity" let-row>
        <span class="chip" [class]="severityChip(row.severity)">{{ severityLabel(row.severity) }}</span>
      </ng-template>
      <ng-template dataTableCell="status" let-row>
        @if (row.revoked_at) {
          <span class="chip">{{ t('warns.revoked') }}</span>
        } @else {
          <span class="chip chip--warning">{{ t('warns.active') }}</span>
        }
      </ng-template>
      <ng-template dataTableCell="created_at" let-row>
        <span style="color: var(--color-text-secondary); font-size: 0.85rem">{{
          row.created_at | date: 'short'
        }}</span>
      </ng-template>
      <ng-template dataTableCell="actions" let-row>
        @if (canIssue() && !row.revoked_at) {
          <button
            type="button"
            class="btn btn--outline btn--sm"
            [disabled]="revokingId() === row.id"
            (click)="revoke(row.id)"
          >
            {{ t('warns.revoke') }}
          </button>
        } @else {
          <span style="color: var(--color-text-secondary)">{{ t('bank.actions.none') }}</span>
        }
      </ng-template>
    </app-data-table>
  `,
})
export class Warns {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly warns = signal<WarnView[]>([]);
  protected readonly escalations = signal<WarnEscalationView[]>([]);
  protected readonly members = signal<UserProfile[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly showIssueForm = signal(false);
  protected readonly issueDraft = signal<IssueDraft>(emptyIssueDraft());
  protected readonly ackingId = signal<number | null>(null);
  protected readonly revokingId = signal<number | null>(null);
  protected readonly trackById = (row: WarnView): unknown => row.id;

  protected readonly canIssue = computed(() => this.auth.hasPermission('warns.issue'));

  private readonly memberName = computed(() => {
    const map = new Map<number, string>();
    for (const user of this.members()) {
      map.set(user.id, user.username);
    }
    return map;
  });

  protected readonly columns = computed<readonly DataTableColumn<WarnView>[]>(() => [
    {
      key: 'created_at',
      label: 'warns.issued',
      sortable: true,
      accessor: (row) => row.created_at,
      comparator: (a, b) => b.created_at.localeCompare(a.created_at),
    },
    {
      key: 'user',
      label: 'warns.user',
      sortable: true,
      searchable: true,
      accessor: (row) => this.displayName(row.user_id, row.username),
      comparator: (a, b) =>
        this.displayName(a.user_id, a.username).localeCompare(this.displayName(b.user_id, b.username)),
    },
    {
      key: 'severity',
      label: 'warns.severity',
      sortable: true,
      accessor: (row) => row.severity,
      comparator: (a, b) => a.severity.localeCompare(b.severity),
      filterOptions: [
        { value: 'note', label: this.t('warns.severity.note') },
        { value: 'warn', label: this.t('warns.severity.warn') },
        { value: 'strike', label: this.t('warns.severity.strike') },
      ],
    },
    {
      key: 'reason',
      label: 'warns.reason',
      searchable: true,
      accessor: (row) => row.reason,
    },
    {
      key: 'status',
      label: 'warns.status',
      sortable: true,
      accessor: (row) => (row.revoked_at ? 'revoked' : 'active'),
      comparator: (a, b) => Number(Boolean(a.revoked_at)) - Number(Boolean(b.revoked_at)),
      filterOptions: [
        { value: 'active', label: this.t('warns.active') },
        { value: 'revoked', label: this.t('warns.revoked') },
      ],
    },
    {
      key: 'actions',
      label: 'common.actions',
    },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected displayName(userId: number, username?: string | null): string {
    return username || this.memberName().get(userId) || `#${userId}`;
  }

  protected severityLabel(severity: WarnSeverity): string {
    if (severity === 'note') {
      return this.t('warns.severity.note');
    }
    if (severity === 'strike') {
      return this.t('warns.severity.strike');
    }
    return this.t('warns.severity.warn');
  }

  protected severityChip(severity: WarnSeverity): string {
    if (severity === 'strike') {
      return 'chip chip--error';
    }
    if (severity === 'warn') {
      return 'chip chip--warning';
    }
    return 'chip';
  }

  protected toggleIssueForm(): void {
    this.showIssueForm.update((open) => !open);
  }

  protected updateIssue(field: keyof IssueDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.issueDraft.update((current) => ({ ...current, [field]: value }));
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [warns, escalations, members] = await Promise.all([
        firstValueFrom(
          this.api.get<PaginatedData<WarnView> | WarnView[]>('api/warns', {
            page: 1,
            limit: LOAD_LIMIT,
          }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<WarnEscalationView> | WarnEscalationView[]>(
            'api/warns/escalations',
            { open_only: true },
          ),
        ),
        firstValueFrom(
          this.api.get<{ items: UserProfile[] }>('api/users', { page: 1, limit: LOAD_LIMIT }),
        ).catch(() => ({ items: [] as UserProfile[] })),
      ]);
      this.warns.set(asPaginated(warns));
      this.escalations.set(asPaginated(escalations));
      this.members.set(members.items ?? []);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async onIssueSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const draft = this.issueDraft();
    const userId = Number(draft.userId);
    const reason = draft.reason.trim();
    if (!userId || !reason) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const body: CreateWarnRequest = {
      user_id: userId,
      reason,
      severity: draft.severity,
    };
    if (draft.multiplier.trim() !== '') {
      body.multiplier = Number(draft.multiplier);
    }
    if (draft.expiresAt.trim() !== '') {
      body.multiplier_expires_at = new Date(draft.expiresAt).toISOString();
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post<WarnView>('api/warns', body));
      this.issueDraft.set(emptyIssueDraft());
      this.showIssueForm.set(false);
      this.toasts.success(this.t('warns.issueSuccess'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async revoke(id: number): Promise<void> {
    if (this.revokingId() !== null) {
      return;
    }
    this.revokingId.set(id);
    try {
      await firstValueFrom(this.api.post<WarnView>(`api/warns/${id}/revoke`, null));
      this.toasts.success(this.t('warns.revokeSuccess'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.revokingId.set(null);
    }
  }

  protected async ack(id: number): Promise<void> {
    if (this.ackingId() !== null) {
      return;
    }
    this.ackingId.set(id);
    try {
      await firstValueFrom(this.api.post<WarnEscalationView>(`api/warns/escalations/${id}/ack`, null));
      this.toasts.success(this.t('warns.acked'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.ackingId.set(null);
    }
  }
}
