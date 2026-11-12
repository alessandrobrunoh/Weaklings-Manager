import { ChangeDetectionStrategy, Component, computed, forwardRef, input, model, output, signal, type OnChanges, type SimpleChanges } from '@angular/core';
import { type AbstractControl, type ControlValueAccessor, NG_VALIDATORS, NG_VALUE_ACCESSOR, type ValidationErrors, type Validator } from '@angular/forms';

@Component({
  selector: 'app-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => Checkbox), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => Checkbox), multi: true },
  ],
  styles: `
    :host { display: block; }
    label { display: inline-flex; align-items: flex-start; gap: 0.5rem; min-height: var(--control-h); padding-block: 0.4375rem; font-size: var(--ui-text-md); line-height: 1.25rem; cursor: pointer; }
    input { flex: none; margin-top: 0.125rem; accent-color: var(--color-primary); }
    input:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-ring-offset); }
    input:disabled { cursor: not-allowed; }
    input:disabled + span { opacity: 0.6; }
    .hint { display: block; margin-top: 0.125rem; font-size: var(--ui-text-xs); line-height: 1rem; color: var(--color-text-secondary); }
    .required { color: var(--color-error); }
  `,
  template: `
    <label>
      <input
        class="checkbox"
        type="checkbox"
        [id]="inputId()"
        [checked]="displayChecked()"
        [indeterminate]="indeterminate()"
        [disabled]="formBound() ? formDisabled() : disabled()"
        [required]="required()"
        [attr.name]="name()"
        [value]="value()"
        [attr.aria-labelledby]="inputId() + '-label'"
        [attr.aria-describedby]="hint() ? inputId() + '-hint' : null"
        (change)="onChange($event)"
        (blur)="onTouched()"
      />
      <span>
        <span [id]="inputId() + '-label'">{{ label() }}</span>
        @if (required()) { <span class="required" aria-hidden="true">*</span> }
        @if (hint()) { <span class="hint" [id]="inputId() + '-hint'">{{ hint() }}</span> }
      </span>
    </label>
  `,
})
export class Checkbox implements ControlValueAccessor, Validator, OnChanges {
  readonly inputId = input.required<string>();
  readonly label = input.required<string>();
  readonly hint = input('');
  readonly checked = input(false);
  readonly checkedChange = output<boolean>();
  readonly indeterminate = model(false);
  /** For standalone use; with Angular forms use control.disable()/enable(). */
  readonly disabled = input(false);
  readonly required = input(false);
  readonly name = input<string | null>(null);
  readonly value = input('on');
  protected readonly formDisabled = signal(false);
  protected readonly formBound = signal(false);
  private readonly formValue = signal(false);
  protected readonly displayChecked = computed(() => this.formBound() ? this.formValue() : this.checked());

  private propagateChange: (value: boolean) => void = () => {};
  private validatorChange: () => void = () => {};
  protected onTouched: () => void = () => {};

  writeValue(value: boolean | null): void {
    this.formValue.set(value === true);
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this.formBound.set(true);
    this.propagateChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.formDisabled.set(disabled);
  }

  validate(control: AbstractControl): ValidationErrors | null {
    return this.required() && control.value !== true ? { required: true } : null;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.validatorChange = fn;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['required']) this.validatorChange();
  }

  protected onChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.formValue.set(checked);
    this.indeterminate.set(false);
    this.checkedChange.emit(checked);
    this.propagateChange(checked);
  }
}
