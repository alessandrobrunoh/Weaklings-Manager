import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { IntelRoster, IntelRosterMember } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { IntelFormat } from './intel-format';
import { IntelPeriod, IntelPeriodState } from './intel-period';

/**
 * Intel players: every member's combat record over the selected period.
 *
 * Officers (`intel.report.view`) get the whole roster; everyone else gets only their own row,
 * decided by the backend, and a note says so. A row opens the member's page only when the
 * viewer may see it: their own, or any member for an officer.
 */
@Component({
  selector: 'app-intel-players',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, IntelPeriod, PageStack, RouterLink],
  template: `
    <app-page-stack>
      <app-intel-period />
      <p class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.pl.hint') }}</p>
      @if (data()?.scope === 'self') {
        <p class="text-xs" role="note" style="color: var(--color-text-secondary)">{{ t('intel.pl.selfNote') }}</p>
      }

      <app-data-table
        [columns]="columns()"
        [rows]="rows()"
        [loading]="loading()"
        [error]="failed()"
        (retry)="reload()"
        [trackBy]="trackMember"
        [pageSize]="25"
        emptyIcon="users"
        [emptyLabel]="'intel.pl.empty'"
        [rowClickable]="true"
        (rowClick)="open($event)"
      >
        <ng-template dataTableCell="member" let-row>
          @if (canOpen(row)) {
            <a
              class="font-medium no-underline hover:underline"
              style="color: var(--color-text)"
              [routerLink]="['/intel/players', row.user_id]"
              [queryParams]="period.queryParams()"
              (click)="$event.stopPropagation()"
            >
              {{ row.username }}
            </a>
          } @else {
            <span class="font-medium">{{ row.username }}</span>
          }
          @if (row.albion_name && row.albion_name !== row.username) {
            <span class="ml-1 text-xs" style="color: var(--color-text-tertiary)">{{ row.albion_name }}</span>
          } @else if (!row.linked) {
            <span class="ml-1 text-xs" style="color: var(--color-text-tertiary)">{{ t('intel.notLinked') }}</span>
          }
        </ng-template>
        <ng-template dataTableCell="fights" let-row>
          @if (row.fights === 0) {
            <span class="text-xs" style="color: var(--color-text-tertiary)">{{ t('intel.pl.noFights') }}</span>
          } @else {
            <span class="mono">{{ fmt.int(row.fights) }}</span>
          }
        </ng-template>
        <ng-template dataTableCell="attendance" let-row>
          <span class="mono">{{ fmt.pct(row.attendance_rate) }}</span>
        </ng-template>
        <ng-template dataTableCell="win_rate" let-row>
          <span class="mono">{{ fmt.pct(row.win_rate) }}</span>
        </ng-template>
        <ng-template dataTableCell="kd" let-row>
          <span class="mono">{{ fmt.ratio(row.kd_ratio) }}</span>
        </ng-template>
        <ng-template dataTableCell="kills" let-row>
          <span class="mono">{{ fmt.int(row.kills) }}</span>
        </ng-template>
        <ng-template dataTableCell="deaths" let-row>
          <span class="mono">{{ fmt.int(row.deaths) }}</span>
        </ng-template>
        <ng-template dataTableCell="kill_fame" let-row>
          <span class="mono">{{ fmt.compact(row.kill_fame) }}</span>
        </ng-template>
        <ng-template dataTableCell="ip" let-row>
          <span class="mono">{{ fmt.int(row.avg_item_power) }}</span>
        </ng-template>
        <ng-template dataTableCell="weapons" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ weaponsLabel(row) }}</span>
        </ng-template>
        <ng-template dataTableCell="role" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ fmt.role(row.main_role) }}</span>
        </ng-template>
        <ng-template dataTableCell="last_fight" let-row>
          <span class="text-sm" style="color: var(--color-text-secondary)">{{ fmt.date(row.last_fight_at) }}</span>
        </ng-template>
      </app-data-table>

      @if ((data()?.unlinked_players?.length ?? 0) > 0) {
        <section class="card p-4" aria-labelledby="intel-pl-unlinked">
          <h2 class="eyebrow" id="intel-pl-unlinked">{{ t('intel.pl.unlinked') }}</h2>
          <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">{{ t('intel.pl.unlinkedHint') }}</p>
          <ul class="mt-3 flex flex-wrap gap-2">
            @for (player of data()!.unlinked_players; track player.name) {
              <li class="chip chip--neutral">
                {{ player.name }}
                <span class="mono ml-1 opacity-80">{{ t('intel.pl.fightsCount', { n: player.fights }) }}</span>
              </li>
            }
          </ul>
        </section>
      }
    </app-page-stack>
  `,
})
export class IntelPlayersPage {
  private readonly intel = inject(IntelService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly fmt = inject(IntelFormat);
  protected readonly period = inject(IntelPeriodState);

  protected readonly data = signal<IntelRoster | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private requestId = 0;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly rows = computed<IntelRosterMember[]>(() =>
    [...(this.data()?.members ?? [])].sort(
      (a, b) => b.fights - a.fights || a.username.localeCompare(b.username),
    ),
  );

  protected readonly columns = computed<readonly DataTableColumn<IntelRosterMember>[]>(() => [
    { key: 'member', label: 'intel.pl.member', searchable: true, sortable: true, accessor: (r) => r.username },
    { key: 'fights', label: 'intel.fights', sortable: true, accessor: (r) => r.fights, align: 'right' },
    { key: 'attendance', label: 'intel.pl.attendance', sortable: true, accessor: (r) => r.attendance_rate ?? -1, align: 'right' },
    { key: 'win_rate', label: 'intel.winRate', sortable: true, accessor: (r) => r.win_rate ?? -1, align: 'right' },
    { key: 'kd', label: 'intel.kd', sortable: true, accessor: (r) => r.kd_ratio ?? -1, align: 'right' },
    { key: 'kills', label: 'intel.kills', sortable: true, accessor: (r) => r.kills, align: 'right' },
    { key: 'deaths', label: 'intel.col.deaths', sortable: true, accessor: (r) => r.deaths, align: 'right' },
    { key: 'kill_fame', label: 'intel.killFame', sortable: true, accessor: (r) => r.kill_fame, align: 'right' },
    { key: 'ip', label: 'intel.avgIp', sortable: true, accessor: (r) => r.avg_item_power ?? -1, align: 'right' },
    { key: 'weapons', label: 'intel.pl.weapons', accessor: (r) => this.weaponsLabel(r) },
    { key: 'role', label: 'intel.pl.mainRole', accessor: (r) => r.main_role },
    { key: 'last_fight', label: 'intel.pl.lastFight', sortable: true, accessor: (r) => r.last_fight_at ?? '' },
  ]);

  protected readonly trackMember = (row: IntelRosterMember): unknown => row.user_id;

  constructor() {
    effect(() => {
      const query = this.period.query();
      untracked(() => void this.load(query));
    });
  }

  protected reload(): void {
    void this.load(this.period.query());
  }

  protected canOpen(row: IntelRosterMember): boolean {
    return (
      this.auth.hasPermission('intel.report.view') || row.user_id === this.auth.profile()?.user_id
    );
  }

  protected open(row: IntelRosterMember): void {
    if (this.canOpen(row)) {
      void this.router.navigate(['/intel/players', row.user_id], {
        queryParams: this.period.queryParams(),
      });
    }
  }

  protected weaponsLabel(row: IntelRosterMember): string {
    const names = row.weapons.slice(0, 2).map((weapon) => this.fmt.weapon(weapon.weapon));
    return names.length === 0 ? '—' : names.join(', ');
  }

  private async load(query: ReturnType<IntelPeriodState['query']>): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const roster = await firstValueFrom(this.intel.roster(query));
      if (id === this.requestId) {
        this.data.set(roster);
      }
    } catch {
      if (id === this.requestId) {
        this.failed.set(true);
        this.data.set(null);
      }
    } finally {
      if (id === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
