import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { Icon } from '../icon/icon';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

let nextId = 0;

/**
 * Custom single-select. The value lives in the parent, so a re-render cannot
 * reset it the way a native `<select>` does when options arrive later.
 * A visually hidden input keeps native form `required` checks working.
 */
@Component({
  selector: 'app-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class: 'app-select',
    '[class.app-select--sm]': 'size() === "sm"',
    '(document:pointerdown)': 'onDocumentPointer($event)',
    '(document:keydown)': 'onDocumentKey($event)',
  },
  styles: `
    :host { display: block; position: relative; }
    .app-select__trigger {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      text-align: start;
      cursor: pointer;
    }
    .app-select__trigger:disabled { cursor: not-allowed; opacity: 0.6; }
    .app-select__value { flex: 1; min-width: 0; }
    .app-select__placeholder { color: var(--color-text-disabled); }
    .app-select__chevron { flex-shrink: 0; color: var(--color-text-secondary); }
    .app-select__panel {
      position: absolute;
      z-index: 40;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      margin: 0;
      padding: 0.25rem;
      list-style: none;
      max-height: 16rem;
      overflow: auto;
      border-radius: var(--radius-inputs);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      box-shadow: var(--shadow-xl);
    }
    .app-select__option {
      width: 100%;
      text-align: start;
      border: 0;
      border-radius: 6px;
      padding: 0.5rem 0.625rem;
      background: transparent;
      color: var(--color-text);
      cursor: pointer;
      font: inherit;
    }
    .app-select__option:hover,
    .app-select__option[data-active='true'] { background: var(--color-surface-hover); }
    .app-select__option[aria-selected='true'] { font-weight: 600; }
    .app-select__option:disabled { opacity: 0.5; cursor: not-allowed; }
    .app-select__ghost {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `,
  template: `
    <button
      type="button"
      class="select app-select__trigger"
      [class.select--sm]="size() === 'sm'"
      role="combobox"
      [id]="triggerId"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-required]="required() ? 'true' : null"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="listId"
      aria-haspopup="listbox"
      (click)="toggle()"
      (keydown)="onTriggerKey($event)"
    >
      <span class="app-select__value truncate">
        @if (selected(); as current) {
          {{ current.label }}
        } @else {
          <span class="app-select__placeholder">{{ placeholder() }}</span>
        }
      </span>
      <app-icon class="app-select__chevron" name="chevron-down" size="0.875rem" />
    </button>
    <input
      class="app-select__ghost"
      tabindex="-1"
      aria-hidden="true"
      [required]="required()"
      [value]="value()"
      (invalid)="$event.preventDefault()"
    />
    @if (open()) {
      <ul class="app-select__panel" role="listbox" [id]="listId" [attr.aria-labelledby]="triggerId">
        @for (option of options(); track option.value; let i = $index) {
          <li role="presentation">
            <button
              type="button"
              class="app-select__option"
              role="option"
              [disabled]="option.disabled"
              [attr.aria-selected]="option.value === value()"
              [attr.data-active]="activeIndex() === i"
              (mouseenter)="activeIndex.set(i)"
              (click)="choose(option)"
            >
              {{ option.label }}
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class Select {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly options = input<readonly SelectOption[]>([]);
  readonly value = input('');
  readonly placeholder = input('');
  readonly disabled = input(false);
  readonly required = input(false);
  readonly size = input<'md' | 'sm'>('md');
  readonly ariaLabel = input('');

  readonly valueChange = output<string>();

  protected readonly open = signal(false);
  protected readonly activeIndex = signal(0);
  protected readonly triggerId = `app-select-${++nextId}`;
  protected readonly listId = `${this.triggerId}-list`;

  protected readonly selected = computed(
    () => this.options().find((option) => option.value === this.value()) ?? null,
  );

  protected toggle(): void {
    if (this.disabled()) return;
    if (this.open()) {
      this.open.set(false);
      return;
    }
    const index = this.options().findIndex((option) => option.value === this.value());
    this.activeIndex.set(Math.max(0, index));
    this.open.set(true);
  }

  protected choose(option: SelectOption): void {
    if (option.disabled) return;
    this.valueChange.emit(option.value);
    this.open.set(false);
  }

  protected onTriggerKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!this.open()) this.toggle();
    }
  }

  protected onDocumentPointer(event: PointerEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  protected onDocumentKey(event: KeyboardEvent): void {
    if (!this.open()) return;
    const options = this.options();
    if (event.key === 'Escape') {
      this.open.set(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (this.activeIndex() + step + options.length) % Math.max(options.length, 1);
      this.activeIndex.set(next);
      return;
    }
    if (event.key === 'Enter') {
      const option = options[this.activeIndex()];
      if (option) this.choose(option);
    }
  }
}
