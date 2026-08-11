import { ChangeDetectionStrategy, Component, EventEmitter, inject, input, Output, signal } from '@angular/core';
import { Icon } from '../icon/icon';
import { TranslateService } from '../../../core/services/translate.service';
import { Loading } from '../loading/loading';
import { EmptyState } from '../empty-state/empty-state';
import type { TranslationKey } from '../../../i18n/en';

export interface SearchDialogOption {
  id: string | number;
  title: string;
  subtitle?: string;
  chip?: string;
}

@Component({
  selector: 'app-search-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Loading, EmptyState],
  template: `
    <div class="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div class="fixed inset-0 bg-black/60 backdrop-blur-sm" (click)="close.emit()"></div>
      <div
        class="relative w-full max-w-2xl overflow-hidden rounded-xl shadow-2xl flex flex-col"
        style="background: var(--color-surface); max-height: 90vh;"
      >
        <header class="flex items-center justify-between border-b p-4" style="border-color: var(--color-border)">
          <h2 class="text-lg font-bold" style="color: var(--color-text)">{{ title() }}</h2>
          <button type="button" class="btn btn--ghost" (click)="close.emit()">
            <app-icon name="close" size="1.25rem" />
          </button>
        </header>

        <div class="p-4 border-b grid gap-3" style="border-color: var(--color-border); background: var(--color-surface-1)">
          <div class="relative">
            <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <app-icon name="search" size="1rem" color="var(--color-text-secondary)" />
            </div>
            <input
              type="search"
              class="input pl-10"
              [placeholder]="placeholder()"
              [value]="searchQuery()"
              (input)="onSearchChange($event)"
            />
          </div>
          
          @if (showDateFilters()) {
            <div class="grid grid-cols-2 gap-3">
              <label>
                <span class="label">{{ t('common.date') }} From</span>
                <input type="date" class="input" [value]="dateFrom()" (input)="onDateFromChange($event)" />
              </label>
              <label>
                <span class="label">{{ t('common.date') }} To</span>
                <input type="date" class="input" [value]="dateTo()" (input)="onDateToChange($event)" />
              </label>
            </div>
          }
        </div>

        <div class="overflow-y-auto p-4 flex-1">
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
                    class="w-full text-left p-3 rounded-lg flex items-center justify-between gap-3 hover-surface transition-colors"
                    style="border: 1px solid var(--color-border)"
                    (click)="select.emit(opt)"
                  >
                    <div>
                      <p class="font-medium" style="color: var(--color-text)">{{ opt.title }}</p>
                      @if (opt.subtitle) {
                        <p class="text-xs mt-1" style="color: var(--color-text-secondary)">{{ opt.subtitle }}</p>
                      }
                    </div>
                    @if (opt.chip) {
                      <span class="chip">{{ opt.chip }}</span>
                    }
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .hover-surface:hover {
      background: var(--color-surface-2);
    }
  `
})
export class SearchDialog {
  title = input.required<string>();
  placeholder = input<string>('Search...');
  options = input.required<SearchDialogOption[]>();
  loading = input<boolean>(false);
  showDateFilters = input<boolean>(false);

  @Output() close = new EventEmitter<void>();
  @Output() select = new EventEmitter<SearchDialogOption>();
  @Output() filterChange = new EventEmitter<{ search: string; dateFrom: string; dateTo: string }>();

  searchQuery = signal('');
  dateFrom = signal('');
  dateTo = signal('');

  private readonly translate = inject(TranslateService);
  t = (key: TranslationKey | string) => this.translate.t(key as any);

  protected onSearchChange(event: Event) {
    this.searchQuery.set((event.target as HTMLInputElement).value);
    this.emitChange();
  }

  protected onDateFromChange(event: Event) {
    this.dateFrom.set((event.target as HTMLInputElement).value);
    this.emitChange();
  }

  protected onDateToChange(event: Event) {
    this.dateTo.set((event.target as HTMLInputElement).value);
    this.emitChange();
  }

  private emitChange() {
    this.filterChange.emit({
      search: this.searchQuery(),
      dateFrom: this.dateFrom(),
      dateTo: this.dateTo()
    });
  }
}
