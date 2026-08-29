import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  inject,
  input,
  OnDestroy,
  Output,
  signal,
  viewChild,
} from '@angular/core';
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
        #panel
        class="relative w-full max-w-2xl overflow-hidden rounded-2xl flex flex-col"
        style="background: var(--color-surface); border: 1px solid var(--color-border); box-shadow: var(--shadow-xl); max-height: 90vh;"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="titleId"
      >
        <header class="flex items-center justify-between border-b p-4" style="border-color: var(--color-border)">
          <h2 [id]="titleId" class="text-lg font-bold" style="color: var(--color-text)">{{ title() }}</h2>
          <button type="button" class="btn btn--ghost" [attr.aria-label]="t('common.close')" (click)="close.emit()">
            <app-icon name="close" size="1.25rem" />
          </button>
        </header>

        <div class="p-4 border-b grid gap-3" style="border-color: var(--color-border); background: var(--color-surface-1)">
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
export class SearchDialog implements OnDestroy {
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

  /** Stable per-instance id linking the dialog to its title for `aria-labelledby`. */
  protected readonly titleId = `search-dialog-title-${Math.random().toString(36).slice(2)}`;

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly searchInputEl = viewChild<ElementRef<HTMLInputElement>>('searchInputEl');
  private previouslyFocused: HTMLElement | null = null;

  private readonly translate = inject(TranslateService);
  t = (key: TranslationKey | string) => this.translate.t(key as any);

  /**
   * This dialog is a bare `<div>` overlay, not a native `<dialog>`, so none
   * of the browser's built-in focus handling applies. Without this a
   * keyboard user opening it stayed focused on (or lost focus from) whatever
   * triggered it, with no indication a modal had appeared, and closing it
   * never returned them to where they were.
   */
  constructor() {
    afterNextRender(() => {
      this.previouslyFocused = document.activeElement as HTMLElement | null;
      this.searchInputEl()?.nativeElement.focus();
    });
  }

  ngOnDestroy(): void {
    this.previouslyFocused?.focus?.();
  }

  @HostListener('keydown.escape')
  protected onEscape(): void {
    this.close.emit();
  }

  /** Keeps Tab from leaving the dialog into the page behind the backdrop.
   *  Typed as `Event` rather than `KeyboardEvent` because that's what
   *  `@HostListener`'s dotted-key event binding actually infers. */
  @HostListener('keydown.tab', ['$event'])
  protected onTab(domEvent: Event): void {
    const event = domEvent as KeyboardEvent;
    const panelEl = this.panel()?.nativeElement;
    if (!panelEl) {
      return;
    }
    const focusable = panelEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

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
