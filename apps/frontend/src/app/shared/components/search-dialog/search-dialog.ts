import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Dialog } from '../dialog/dialog';
import { EmptyState } from '../empty-state/empty-state';
import { Icon } from '../icon/icon';
import { Loading } from '../loading/loading';

export interface SearchDialogOption {
  id: string | number;
  title: string;
  subtitle?: string;
  chip?: string;
}

/**
 * Searchable picker built on `app-dialog`.
 *
 * Parents render this only while it is open; closing emits `close` so they
 * can destroy it. Focus lands on the search field after the native dialog
 * has opened.
 */
@Component({
  selector: 'app-search-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, Icon, Loading, EmptyState],
  template: `
    <app-dialog [title]="title()" (closed)="close.emit()">
      <div class="grid gap-3">
        <div class="relative">
          <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <app-icon name="search" size="1rem" color="var(--color-text-secondary)" />
          </div>
          <input
            #searchInputEl
            type="search"
            class="input pl-10"
            [placeholder]="placeholder()"
            [attr.aria-label]="title()"
            [value]="searchQuery()"
            (input)="onSearchChange($event)"
          />
        </div>

        @if (showDateFilters()) {
          <div class="grid grid-cols-2 gap-3">
            <label>
              <span class="label">{{ t('common.date') }} From</span>
              <input
                type="date"
                class="input"
                [value]="dateFrom()"
                (input)="onDateFromChange($event)"
              />
            </label>
            <label>
              <span class="label">{{ t('common.date') }} To</span>
              <input
                type="date"
                class="input"
                [value]="dateTo()"
                (input)="onDateToChange($event)"
              />
            </label>
          </div>
        }

        @if (loading()) {
          <div class="py-8"><app-loading [label]="t('common.loading')" /></div>
        } @else if (options().length === 0) {
          <app-empty-state [message]="t('common.empty')" icon="search" />
        } @else {
          <ul class="grid gap-2">
            @for (opt of options(); track opt.id) {
              <li>
                <button
                  type="button"
                  class="search-item-btn"
                  (click)="select.emit(opt)"
                >
                  <div class="min-w-0 flex-1">
                    <p class="font-medium text-white truncate text-sm">{{ opt.title }}</p>
                    @if (opt.subtitle) {
                      <p class="text-xs mt-0.5 text-[var(--color-text-secondary)] truncate">
                        {{ opt.subtitle }}
                      </p>
                    }
                  </div>
                  @if (opt.chip) {
                    <span class="chip chip--neutral font-mono text-[10px]">{{ opt.chip }}</span>
                  }
                  <app-icon name="chevron-right" size="0.875rem" class="text-[var(--color-text-tertiary)] shrink-0" />
                </button>
              </li>
            }
          </ul>
        }
      </div>
    </app-dialog>
  `,
  styles: `
    .search-item-btn {
      width: 100%;
      text-align: left;
      padding: 0.75rem 0.875rem;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      transition: border-color var(--motion-fast), background-color var(--motion-fast);
      cursor: pointer;
    }
    .search-item-btn:hover,
    .search-item-btn:focus-visible {
      border-color: var(--color-border-hover);
      background: var(--color-surface-hover);
    }
  `,
})
export class SearchDialog {
  readonly title = input.required<string>();
  readonly placeholder = input<string>('Search...');
  readonly options = input.required<SearchDialogOption[]>();
  readonly loading = input<boolean>(false);
  readonly showDateFilters = input<boolean>(false);

  readonly close = output<void>();
  readonly select = output<SearchDialogOption>();
  readonly filterChange = output<{ search: string; dateFrom: string; dateTo: string }>();

  protected readonly searchQuery = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');

  private readonly searchInputEl = viewChild<ElementRef<HTMLInputElement>>('searchInputEl');
  private readonly translate = inject(TranslateService);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    afterNextRender(() => {
      this.searchInputEl()?.nativeElement.focus();
    });
  }

  protected onSearchChange(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
    this.emitChange();
  }

  protected onDateFromChange(event: Event): void {
    this.dateFrom.set((event.target as HTMLInputElement).value);
    this.emitChange();
  }

  protected onDateToChange(event: Event): void {
    this.dateTo.set((event.target as HTMLInputElement).value);
    this.emitChange();
  }

  private emitChange(): void {
    this.filterChange.emit({
      search: this.searchQuery(),
      dateFrom: this.dateFrom(),
      dateTo: this.dateTo(),
    });
  }
}
