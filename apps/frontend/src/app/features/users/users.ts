import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { PaginatedData, Role, UserProfile } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

const PAGE_SIZE = 10;

/**
 * Guild member directory.
 *
 * Drives the participant picker used elsewhere (splits, events), but exposed
 * here as a browsable list with username substring search and pagination.
 */
@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading],
  template: `
    <app-page-header
      [title]="t('users.title')"
      [subtitle]="t('users.subtitle')"
      [actions]="false"
    />

    <form class="mb-4 flex gap-2" (submit)="onSearchSubmit($event)">
      <input
        type="text"
        class="input"
        [placeholder]="t('common.username')"
        [value]="query()"
        (input)="onQueryChange($event)"
      />
      <button type="submit" class="btn btn--primary">
        {{ t('common.search') }}
      </button>
    </form>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (users().length === 0) {
      <app-empty-state [message]="t('common.empty')" icon="users" />
    } @else {
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('common.username') }}</th>
              <th>{{ t('common.email') }}</th>
              <th>{{ t('common.role') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (user of users(); track user.id) {
              <tr>
                <td style="font-weight: 500">{{ user.username }}</td>
                <td style="color: var(--color-text-secondary)">{{ user.email }}</td>
                <td>
                  <span class="chip" [class]="roleChip(user.role)">{{ user.role }}</span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="mt-4 flex items-center justify-between">
        <p class="text-xs" style="color: var(--color-text-secondary)">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }}
        </p>
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" [disabled]="page() <= 1" (click)="prev()">
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline"
            [disabled]="page() >= totalPages()"
            (click)="next()"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </div>
    }
  `,
})
export class Users {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly users = signal<UserProfile[]>([]);
  protected readonly loading = signal(false);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly query = signal('');

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected onQueryChange(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected async search(): Promise<void> {
    this.page.set(1);
    await this.load();
  }

  protected onSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.search();
  }

  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => p + 1);
    await this.load();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => p - 1);
    await this.load();
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

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string | number> = { page: this.page(), limit: PAGE_SIZE };
      const q = this.query().trim();
      if (q) {
        params['username'] = q;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', params),
      );
      this.users.set(data.items);
      this.totalPages.set(data.total_pages);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
