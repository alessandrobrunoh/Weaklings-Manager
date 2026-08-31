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
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

type WarnsTab = 'register' | 'escalations';

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

function emptyPageChange(pageSize = 20): DataTablePageChange {
  return { page: 1, pageSize, search: '', sort: null, columnFilters: {} };
}

function isWarnsTab(value: string): value is WarnsTab {
  return value === 'register' || value === 'escalations';
}

/**
 * Guild warn register and escalation queue.
 *
 * Officers issue and revoke warns, and acknowledge threshold escalations after
 * a manual Albion/Discord kick. The page is role-gated at the route.
 */
@Component({
  selector: 'app-warns',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DataTable,
    DataTableCell,
    Dialog,
    Icon,
    PageHeader,
    PageStack,
    StatCard,
    ViewToggle,
  ],
  template: `
    <app-page-header [title]="t('warns.title')" [subtitle]="t('warns.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canIssue() && tab() === 'register') {
        <button type="button" class="btn btn--primary btn--sm" (click)="openIssueForm()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('warns.issue') }}
        </button>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Warns summary">
        <app-stat-card
          [label]="t('warns.stat.active')"
          [value]="activeWarnsCount()"
          icon="alert"
          tone="warning"
        />
        <app-stat-card
          [label]="t('warns.stat.strikes')"
          [value]="strikesCount()"
          icon="alert"
          tone="danger"
        />
        <app-stat-card
          [label]="t('warns.stat.notes')"
          [value]="notesCount()"
          icon="list"
          tone="neutral"
        />
        <app-stat-card
          [label]="t('warns.stat.escalations')"
          [value]="escalationTotal()"
          icon="sparkles"
          tone="primary"
        />
      </section>

      @if (tab() === 'register') {
        <app-data-table
          [columns]="columns()"
          [rows]="warns()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackById"
          [serverMode]="true"
          [totalItems]="warnTotal()"
          [pageSize]="20"
          emptyIcon="alert"
          (pageChange)="onWarnsChange($event)"
        >
          <ng-template dataTableCell="user" let-row>
            <span style="font-weight: 500">{{ displayName(row.user_id, row.username) }}</span>
          </ng-template>
          <ng-template dataTableCell="severity" let-row>
            <span class="chip" [class]="severityChip(row.severity)">{{
              severityLabel(row.severity)
            }}</span>
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
                (click)="askRevoke(row.id)"
              >
                {{ t('warns.revoke') }}
              </button>
            } @else {
              <span style="color: var(--color-text-secondary)">{{ t('bank.actions.none') }}</span>
            }
          </ng-template>
        </app-data-table>
      } @else {
        <app-data-table
          [columns]="escalationColumns"
          [rows]="escalations()"
          [loading]="loading()"
          [error]="loadFailed()"
          (retry)="load()"
          [trackBy]="trackEscalation"
          [serverMode]="true"
          [totalItems]="escalationTotal()"
          [pageSize]="20"
          emptyIcon="alert"
          [emptyLabel]="'warns.escalations.empty'"
          (pageChange)="onEscalationsChange($event)"
        >
          <ng-template dataTableCell="user" let-row>
            <span style="font-weight: 500">{{ displayName(row.user_id, row.username) }}</span>
          </ng-template>
          <ng-template dataTableCell="opened_at" let-row>
            <span style="color: var(--color-text-secondary); font-size: 0.85rem">{{
              row.opened_at | date: 'short'
            }}</span>
          </ng-template>
          <ng-template dataTableCell="status" let-row>
            @if (row.acknowledged_at) {
              <span class="chip chip--success">{{ t('warns.acked') }}</span>
            } @else if (row.closed_reason) {
              <span class="chip">{{ row.closed_reason }}</span>
            } @else {
              <span class="chip chip--warning">{{ t('common.open') }}</span>
            }
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (!row.acknowledged_at && !row.closed_reason) {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="ackingId() === row.id"
                (click)="ack(row.id)"
              >
                {{ t('warns.ack') }}
              </button>
            } @else {
              <span style="color: var(--color-text-secondary)">{{ t('bank.actions.none') }}</span>
            }
          </ng-template>
        </app-data-table>
      }
    </app-page-stack>

    @if (showIssueForm()) {
      <app-dialog [title]="t('warns.issue')" (closed)="closeIssueForm()">
        <form id="warn-issue-form" class="grid gap-4 sm:grid-cols-2" (submit)="onIssueSubmit($event)">
          <label>
            <span class="label">{{ t('warns.user') }}</span>
            <select
              class="select"
              [value]="issueDraft().userId"
              (change)="updateIssue('userId', $event)"
              required
            >
              <option value="">{{ t('common.none') }}</option>
              @for (user of members(); track user.id) {
                <option [value]="user.id">{{ user.username }}</option>
              }
            </select>
          </label>
          <label>
            <span class="label">{{ t('warns.severity') }}</span>
            <select
              class="select"
              [value]="issueDraft().severity"
              (change)="updateIssue('severity', $event)"
            >
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
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeIssueForm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="warn-issue-form"
            [disabled]="saving()"
          >
            {{ t('warns.issue') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (revokeId() !== null) {
      <app-dialog [title]="t('common.confirm')" (closed)="revokeId.set(null)">
        <p>{{ t('warns.confirmRevoke') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="revokeId.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="revoke()">
            {{ t('warns.revoke') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Warns {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly tab = signal<WarnsTab>('register');
  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'register', label: this.t('warns.register') },
    { id: 'escalations', label: this.t('warns.escalations') },
  ]);
  protected readonly warns = signal<WarnView[]>([]);
  protected readonly warnTotal = signal(0);
  protected readonly escalations = signal<WarnEscalationView[]>([]);
  protected readonly escalationTotal = signal(0);

  protected readonly activeWarnsCount = computed(
    () => this.warns().filter((w) => !w.revoked_at).length,
  );
  protected readonly strikesCount = computed(
    () => this.warns().filter((w) => w.severity === 'strike' && !w.revoked_at).length,
  );
  protected readonly notesCount = computed(
    () => this.warns().filter((w) => w.severity === 'note' && !w.revoked_at).length,
  );

  protected async refreshNow(): Promise<void> {
    await this.load();
  }
  protected readonly members = signal<UserProfile[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly showIssueForm = signal(false);
  protected readonly issueDraft = signal<IssueDraft>(emptyIssueDraft());
  protected readonly ackingId = signal<number | null>(null);
  protected readonly revokingId = signal<number | null>(null);
  protected readonly revokeId = signal<number | null>(null);
  protected readonly trackById = (row: WarnView): unknown => row.id;
  protected readonly trackEscalation = (row: WarnEscalationView): unknown => row.id;

  protected readonly canIssue = computed(() => this.auth.hasPermission('warns.issue'));

  private readonly warnQuery = signal<DataTablePageChange>(emptyPageChange());
  private readonly escalationQuery = signal<DataTablePageChange>(emptyPageChange());

  protected readonly columns = computed<readonly DataTableColumn<WarnView>[]>(() => [
    {
      key: 'created_at',
      label: 'warns.issued',
      sortable: true,
      accessor: (row) => row.created_at,
    },
    {
      key: 'user',
      label: 'warns.user',
      accessor: (row) => this.displayName(row.user_id, row.username),
    },
    {
      key: 'severity',
      label: 'warns.severity',
      sortable: true,
      accessor: (row) => row.severity,
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
      accessor: (row) => (row.revoked_at ? 'revoked' : 'active'),
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

  protected readonly escalationColumns: readonly DataTableColumn<WarnEscalationView>[] = [
    {
      key: 'opened_at',
      label: 'warns.opened',
      sortable: true,
      accessor: (row) => row.opened_at,
    },
    {
      key: 'user',
      label: 'warns.user',
      accessor: (row) => this.displayName(row.user_id, row.username),
    },
    {
      key: 'warn_count_at_time',
      label: 'warns.count',
      sortable: true,
      accessor: (row) => row.warn_count_at_time,
    },
    {
      key: 'threshold_at_time',
      label: 'warns.threshold',
      sortable: true,
      accessor: (row) => row.threshold_at_time,
    },
    {
      key: 'status',
      label: 'warns.status',
      accessor: (row) =>
        row.acknowledged_at ? 'acked' : row.closed_reason ? 'closed' : 'open',
    },
    {
      key: 'actions',
      label: 'common.actions',
    },
  ];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected displayName(userId: number, username?: string | null): string {
    return username || `#${userId}`;
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

  protected switchTab(tab: string): void {
    if (!isWarnsTab(tab) || this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    void this.load();
  }

  protected onWarnsChange(event: DataTablePageChange): void {
    this.warnQuery.set(event);
    void this.load();
  }

  protected onEscalationsChange(event: DataTablePageChange): void {
    this.escalationQuery.set(event);
    void this.load();
  }

  protected async openIssueForm(): Promise<void> {
    this.showIssueForm.set(true);
    await this.loadMembers();
  }

  protected closeIssueForm(): void {
    this.showIssueForm.set(false);
    this.issueDraft.set(emptyIssueDraft());
  }

  protected updateIssue(field: keyof IssueDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.issueDraft.update((current) => ({ ...current, [field]: value }));
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      if (this.tab() === 'register') {
        await this.loadWarns();
        return;
      }
      await this.loadEscalations();
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadWarns(): Promise<void> {
    const query = this.warnQuery();
    const params: Record<string, string | number | boolean> = {
      page: query.page,
      limit: query.pageSize,
    };
    if (query.search.trim()) {
      params['search'] = query.search.trim();
    }
    if (query.sort) {
      params['sort'] = query.sort.columnKey;
      params['order'] = query.sort.direction;
    }
    const severity = query.columnFilters['severity'];
    if (severity) {
      params['severity'] = severity;
    }
    const status = query.columnFilters['status'];
    if (status === 'revoked') {
      params['revoked'] = true;
    } else if (status === 'active') {
      params['revoked'] = false;
    }
    const data = await firstValueFrom(
      this.api.get<PaginatedData<WarnView>>('api/warns', params),
    );
    this.warns.set(data.items);
    this.warnTotal.set(data.total_items);
  }

  private async loadEscalations(): Promise<void> {
    const query = this.escalationQuery();
    const params: Record<string, string | number | boolean> = {
      page: query.page,
      limit: query.pageSize,
    };
    if (query.sort) {
      params['sort'] = query.sort.columnKey;
      params['order'] = query.sort.direction;
    }
    const data = await firstValueFrom(
      this.api.get<PaginatedData<WarnEscalationView>>('api/warns/escalations', params),
    );
    this.escalations.set(data.items);
    this.escalationTotal.set(data.total_items);
  }

  private async loadMembers(): Promise<void> {
    try {
      const members = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', { page: 1, limit: 100 }),
      );
      this.members.set(members.items ?? []);
    } catch {
      this.members.set([]);
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
      this.closeIssueForm();
      this.toasts.success(this.t('warns.issueSuccess'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askRevoke(id: number): void {
    this.revokeId.set(id);
  }

  protected async revoke(): Promise<void> {
    const id = this.revokeId();
    this.revokeId.set(null);
    if (id === null || this.revokingId() !== null) {
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
      await firstValueFrom(
        this.api.post<WarnEscalationView>(`api/warns/escalations/${id}/ack`, null),
      );
      this.toasts.success(this.t('warns.acked'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.ackingId.set(null);
    }
  }
}
