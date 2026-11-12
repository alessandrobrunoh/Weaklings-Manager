import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChildren,
} from '@angular/core';

/** One option of a {@link ChoiceGroup}. */
export interface ChoiceOption {
  /** Stable value, emitted by `valueChange`. Use `''` for a "none" option. */
  readonly id: string;
  /** Visible, already translated text. */
  readonly label: string;
  /** Optional small leading image (a spell icon). Decorative: the label names the option. */
  readonly iconUrl?: string | null;
  /** Optional longer accessible name, when `label` is a terse symbol. */
  readonly ariaLabel?: string;
}

/**
 * A single-choice control rendered as a row of segments or chips.
 *
 * It is an ARIA radio group: the whole group is one Tab stop (the chosen option, or the first when
 * nothing is chosen) and the arrow keys move the choice, Home and End jump to the ends. That keeps
 * a loadout editor with a dozen choices at a dozen tab stops instead of fifty.
 *
 * Selection never relies on colour alone: the chosen option also gets a heavier border and weight,
 * and `aria-checked` carries it for assistive technology.
 *
 * @example
 * ```html
 * <app-choice-group
 *   [options]="tierOptions()"
 *   [value]="tier()"
 *   [ariaLabel]="t('equipment.tier')"
 *   (valueChange)="setTier($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-choice-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .group {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    .choice {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 2rem;
      max-width: 100%;
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text);
      font: inherit;
      font-size: 0.8125rem;
      line-height: 1.125rem;
      text-align: start;
      cursor: pointer;
    }
    .choice:hover:not([aria-disabled='true']) {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    .choice[aria-checked='true'] {
      border-color: var(--color-primary);
      background: var(--color-primary-subtle);
      box-shadow: inset 0 0 0 1px var(--color-primary);
      font-weight: 600;
    }
    .choice:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .choice[aria-disabled='true'] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .choice__icon {
      flex: 0 0 auto;
      width: 1.25rem;
      height: 1.25rem;
      object-fit: contain;
    }
    .choice__label {
      overflow-wrap: anywhere;
    }
  `,
  template: `
    <div class="group" role="radiogroup" [attr.aria-label]="ariaLabel()">
      @for (option of options(); track option.id) {
        <button
          #choice
          type="button"
          class="choice"
          role="radio"
          [attr.aria-checked]="isChecked(option)"
          [attr.aria-label]="option.ariaLabel ?? null"
          [attr.aria-disabled]="disabled() ? 'true' : null"
          [attr.tabindex]="tabStop() === option.id ? 0 : -1"
          (click)="select(option)"
          (keydown)="onKeydown($event, option)"
        >
          @if (option.iconUrl && !failed.has(option.iconUrl)) {
            <img
              class="choice__icon"
              [src]="option.iconUrl"
              alt=""
              width="20"
              height="20"
              loading="lazy"
              (error)="onIconError($event, option.iconUrl)"
            />
          }
          <span class="choice__label">{{ option.label }}</span>
        </button>
      }
    </div>
  `,
})
export class ChoiceGroup {
  /** The options, in display order. */
  readonly options = input.required<readonly ChoiceOption[]>();
  /** The chosen option's `id`. `null` or an unknown id means nothing is chosen. */
  readonly value = input<string | null>(null);
  /** Accessible name of the group (for example "Tier"). Required for a usable radio group. */
  readonly ariaLabel = input.required<string>();
  /** Ignores clicks and keys. */
  readonly disabled = input(false);

  /** Emits the `id` of the option the user chose. */
  readonly valueChange = output<string>();

  private readonly buttons = viewChildren<ElementRef<HTMLButtonElement>>('choice');

  /** Icons the CDN could not render, so they are dropped instead of leaving a broken image. */
  protected readonly failed = new Set<string>();

  /** The one option in the Tab order: the chosen one, or the first when nothing is chosen. */
  protected readonly tabStop = computed(() => {
    const options = this.options();
    const current = this.value();
    return options.some((option) => option.id === current) ? current : (options[0]?.id ?? null);
  });

  protected isChecked(option: ChoiceOption): boolean {
    return option.id === this.value();
  }

  protected select(option: ChoiceOption): void {
    if (this.disabled() || option.id === this.value()) {
      return;
    }
    this.valueChange.emit(option.id);
  }

  protected onIconError(event: Event, url: string): void {
    this.failed.add(url);
    (event.target as HTMLImageElement).style.display = 'none';
  }

  /** Arrow keys move the choice and focus together, as the radio group pattern prescribes. */
  protected onKeydown(event: KeyboardEvent, option: ChoiceOption): void {
    const options = this.options();
    const index = options.indexOf(option);
    let next = -1;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + options.length) % options.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.buttons()[next]?.nativeElement.focus();
    this.select(options[next]);
  }
}
