import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { Icon } from '../icon/icon';

export interface SearchableSelectOption {
  id: string;
  label: string;
  hint?: string;
  group?: string;
}

let nextSelectId = 0;

/**
 * Searchable single- or multi-select used for Discord roles, channels, and tags.
 *
 * The selected id lives in the parent signal, not in a native `<select>`, so
 * async option lists cannot reset the value to empty on render.
 */
@Component({
  selector: 'app-searchable-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class: 'ss',
    '(document:pointerdown)': 'onDocumentPointer($event)',
    '(document:keydown)': 'onDocumentKey($event)',
  },
  styles: `
    :host {
      display: block;
      position: relative;
    }
    .ss__trigger {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      min-height: 2.5rem;
      text-align: start;
    }
    .ss__value {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      align-items: center;
    }
    .ss__placeholder {
      color: var(--color-text-secondary);
    }
    .ss__chip {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      max-width: 100%;
      border-radius: 999px;
      padding: 0.125rem 0.5rem;
      background: var(--color-surface-2);
      border: 1px solid var(--color-border);
      font-size: 0.75rem;
      color: var(--color-text);
    }
    .ss__chip-remove {
      display: inline-flex;
      border: 0;
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
      padding: 0;
    }
    .ss__chevron {
      flex-shrink: 0;
      color: var(--color-text-secondary);
    }
    .ss__panel {
      position: absolute;
      z-index: 40;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      display: grid;
      gap: 0.5rem;
      padding: 0.5rem;
      border-radius: var(--radius-md, 6px);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      box-shadow: var(--shadow-xl);
    }
    .ss__list {
      max-height: 16rem;
      overflow: auto;
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 2px;
    }
    .ss__group {
      padding: 0.375rem 0.5rem 0.125rem;
      font-size: 0.6875rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .ss__option {
      width: 100%;
      text-align: start;
      border: 0;
      border-radius: 6px;
      padding: 0.5rem 0.625rem;
      background: transparent;
      color: var(--color-text);
      cursor: pointer;
    }
    .ss__option:hover,
    .ss__option[data-active='true'] {
      background: var(--color-surface-hover);
    }
    .ss__option[aria-selected='true'] {
      font-weight: 600;
    }
    .ss__empty {
      padding: 0.75rem 0.5rem;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
  `,
  template: `
    <button
      type="button"
      class="input ss__trigger"
      [id]="triggerId"
      [disabled]="disabled() || loading()"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="listboxId"
      [attr.aria-haspopup]="'listbox'"
      (click)="toggle()"
    >
      <span class="ss__value">
        @if (multiple()) {
          @if (selectedOptions().length === 0) {
            <span class="ss__placeholder">{{ emptyLabel() }}</span>
          } @else {
            @for (opt of selectedOptions(); track opt.id) {
              <span class="ss__chip">
                <span class="truncate">{{ opt.label }}</span>
                <button
                  type="button"
                  class="ss__chip-remove"
                  [attr.aria-label]="clearLabel() + ' ' + opt.label"
                  (click)="removeId($event, opt.id)"
                >
                  <app-icon name="close" size="0.75rem" />
                </button>
              </span>
            }
          }
        } @else if (selectedOption(); as selected) {
          <span class="truncate">{{ selected.label }}</span>
        } @else {
          <span class="ss__placeholder">{{ emptyLabel() }}</span>
        }
      </span>
      <app-icon class="ss__chevron" name="chevron-down" size="0.875rem" />
    </button>

    @if (open()) {
      <div class="ss__panel" (click)="$event.stopPropagation()">
        <input
          #searchEl
          class="input"
          type="search"
          [placeholder]="searchPlaceholder()"
          [attr.aria-label]="searchPlaceholder()"
          [value]="query()"
          (input)="onQuery($event)"
          (keydown)="onSearchKey($event)"
        />
        @if (filtered().length === 0) {
          <p class="ss__empty">{{ emptyMessage() }}</p>
        } @else {
          <ul
            class="ss__list"
            role="listbox"
            [id]="listboxId"
            [attr.aria-multiselectable]="multiple() ? 'true' : null"
            [attr.aria-labelledby]="triggerId"
          >
            @for (row of visibleRows(); track row.track; let i = $index) {
              @if (row.kind === 'group') {
                <li class="ss__group" role="presentation">{{ row.label }}</li>
              } @else {
                <li role="option" [attr.aria-selected]="isSelected(row.id)">
                  <button
                    type="button"
                    class="ss__option"
                    [attr.data-active]="activeIndex() === i"
                    (mouseenter)="activeIndex.set(i)"
                    (click)="choose(row.id)"
                  >
                    {{ row.label }}
                    @if (row.hint) {
                      <span class="mt-0.5 block text-xs" style="color: var(--color-text-secondary)">
                        {{ row.hint }}
                      </span>
                    }
                  </button>
                </li>
              }
            }
          </ul>
        }
      </div>
    }
  `,
})
export class SearchableSelect {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly searchEl = viewChild<ElementRef<HTMLInputElement>>('searchEl');

  readonly options = input<SearchableSelectOption[]>([]);
  readonly value = input('');
  readonly values = input<string[]>([]);
  readonly multiple = input(false);
  readonly allowEmpty = input(true);
  readonly emptyLabel = input('Not set');
  readonly searchPlaceholder = input('Search');
  readonly noMatchesLabel = input('No matches');
  readonly emptyOptionsLabel = input('Nothing to choose');
  readonly clearLabel = input('Clear');
  readonly disabled = input(false);
  readonly loading = input(false);
  readonly ariaLabel = input('');

  readonly valueChange = output<string>();
  readonly valuesChange = output<string[]>();

  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);
  protected readonly triggerId = `ss-trigger-${++nextSelectId}`;
  protected readonly listboxId = `ss-list-${nextSelectId}`;

  protected readonly selectedIds = computed(() =>
    this.multiple() ? this.values() : this.value() ? [this.value()] : [],
  );

  protected readonly selectedOption = computed(() => {
    const id = this.value();
    return this.options().find((option) => option.id === id) ?? null;
  });

  protected readonly selectedOptions = computed(() => {
    const ids = new Set(this.selectedIds());
    return this.options().filter((option) => ids.has(option.id));
  });

  protected readonly filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    const options = this.options();
    if (!query) {
      return options;
    }
    return options.filter((option) => {
      const haystack = `${option.label} ${option.hint ?? ''} ${option.group ?? ''}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
  });

  protected readonly visibleRows = computed(() => {
    const rows: Array<
      | { kind: 'group'; label: string; track: string; id?: never; hint?: never }
      | { kind: 'option'; id: string; label: string; hint?: string; track: string }
    > = [];
    if (this.allowEmpty() && !this.multiple()) {
      rows.push({
        kind: 'option',
        id: '',
        label: this.emptyLabel(),
        track: '__empty__',
      });
    }
    let lastGroup: string | undefined;
    for (const option of this.filtered()) {
      if (option.group && option.group !== lastGroup) {
        lastGroup = option.group;
        rows.push({ kind: 'group', label: option.group, track: `g-${option.group}` });
      }
      rows.push({
        kind: 'option',
        id: option.id,
        label: option.label,
        hint: option.hint,
        track: option.id,
      });
    }
    return rows;
  });

  protected readonly emptyMessage = computed(() =>
    this.options().length === 0 ? this.emptyOptionsLabel() : this.noMatchesLabel(),
  );

  protected toggle(): void {
    if (this.disabled() || this.loading()) {
      return;
    }
    this.open.update((open) => !open);
    if (this.open()) {
      this.query.set('');
      this.activeIndex.set(0);
      setTimeout(() => this.searchEl()?.nativeElement.focus(), 0);
    }
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
  }

  protected isSelected(id: string): boolean {
    return this.selectedIds().includes(id);
  }

  protected choose(id: string): void {
    if (this.multiple()) {
      const next = this.isSelected(id)
        ? this.values().filter((value) => value !== id)
        : [...this.values(), id];
      this.valuesChange.emit(next);
      return;
    }
    this.valueChange.emit(id);
    this.open.set(false);
  }

  protected removeId(event: Event, id: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.valuesChange.emit(this.values().filter((value) => value !== id));
  }

  protected onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const options = this.visibleRows();
      let index = this.activeIndex();
      while (index < options.length && options[index]?.kind !== 'option') {
        index += 1;
      }
      const row = options[index];
      if (row?.kind === 'option') {
        this.choose(row.id);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.open.set(false);
    }
  }

  protected onDocumentPointer(event: Event): void {
    if (!this.open()) {
      return;
    }
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) {
      return;
    }
    this.open.set(false);
  }

  protected onDocumentKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open()) {
      this.open.set(false);
    }
  }

  private moveActive(delta: number): void {
    const rows = this.visibleRows();
    if (rows.length === 0) {
      return;
    }
    let index = this.activeIndex();
    for (let step = 0; step < rows.length; step += 1) {
      index = (index + delta + rows.length) % rows.length;
      if (rows[index]?.kind === 'option') {
        this.activeIndex.set(index);
        return;
      }
    }
  }
}
