import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { Checkbox } from './checkbox';

@Component({
  imports: [Checkbox, ReactiveFormsModule],
  template: `<form><app-checkbox inputId="agreement" label="Agree" hint="Please confirm"
    name="agreement" value="yes" [required]="required()" [(indeterminate)]="mixed"
    [formControl]="control" (checkedChange)="changes.push($event)" /></form>`,
})
class Host {
  readonly control = new FormControl(false, { nonNullable: true });
  readonly changes: boolean[] = [];
  mixed = true;
  readonly required = signal(true);
}

@Component({
  imports: [Checkbox],
  template: `<app-checkbox inputId="standalone" label="Standalone"
    [checked]="checked()" [disabled]="disabled()" (checkedChange)="checked.set($event)" />`,
})
class StandaloneHost {
  readonly checked = signal(false);
  readonly disabled = signal(false);
}

describe('Checkbox', () => {
  it('connects its label, hint and native required and mixed states', () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    expect(input.labels?.[0].textContent).toContain('Agree');
    expect(input.getAttribute('aria-labelledby')).toBe('agreement-label');
    expect(input.getAttribute('aria-describedby')).toBe('agreement-hint');
    expect(input.required).toBe(true);
    expect(input.validity.valueMissing).toBe(true);
    expect(input.indeterminate).toBe(true);
    expect(fixture.nativeElement.querySelector('.required').textContent).toBe('*');
    expect(fixture.componentInstance.control.invalid).toBe(true);
  });

  it('synchronizes user changes, touched state and disabled state with reactive forms', () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    fixture.componentInstance.mixed = false;
    fixture.componentInstance.control.setValue(true);
    fixture.detectChanges();
    expect(input.checked).toBe(true);
    expect(fixture.componentInstance.changes).toEqual([]);
    expect(input.indeterminate).toBe(false);
    input.click();
    input.dispatchEvent(new Event('blur'));
    expect(fixture.componentInstance.control.value).toBe(false);
    expect(fixture.componentInstance.changes).toEqual([false]);
    expect(fixture.componentInstance.control.touched).toBe(true);
    fixture.componentInstance.control.disable();
    fixture.detectChanges();
    expect(input.disabled).toBe(true);
    input.click();
    expect(fixture.componentInstance.control.value).toBe(false);
  });

  it('updates requiredTrue validation when required changes', () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect(fixture.componentInstance.control.hasError('required')).toBe(true);
    fixture.componentInstance.required.set(false);
    fixture.detectChanges();
    expect(fixture.componentInstance.control.valid).toBe(true);
    fixture.componentInstance.required.set(true);
    fixture.detectChanges();
    expect(fixture.componentInstance.control.hasError('required')).toBe(true);
    fixture.componentInstance.control.setValue(true);
    expect(fixture.componentInstance.control.valid).toBe(true);
  });

  it('uses the form control as the sole disabled authority in forms', () => {
    TestBed.configureTestingModule({ imports: [Checkbox], providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(Checkbox);
    fixture.componentRef.setInput('inputId', 'form-checkbox');
    fixture.componentRef.setInput('label', 'Form checkbox');
    fixture.componentRef.setInput('disabled', true);
    fixture.componentInstance.registerOnChange(() => {});
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    expect(input.disabled).toBe(false);
    fixture.componentInstance.setDisabledState(true);
    fixture.detectChanges();
    expect(input.disabled).toBe(true);
    fixture.componentInstance.setDisabledState(false);
    fixture.detectChanges();
    expect(input.disabled).toBe(false);
  });

  it('supports checked and disabled inputs without a form control', () => {
    TestBed.configureTestingModule({ imports: [StandaloneHost], providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(StandaloneHost);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.checked()).toBe(true);
    expect(input.checked).toBe(true);
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    expect(input.disabled).toBe(true);
    input.click();
    expect(fixture.componentInstance.checked()).toBe(true);
    fixture.componentInstance.disabled.set(false);
    fixture.componentInstance.checked.set(false);
    fixture.detectChanges();
    expect(input.disabled).toBe(false);
    expect(input.checked).toBe(false);
  });

  it('clears mixed state on activation and submits name and value only when checked', () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    const form: HTMLFormElement = fixture.nativeElement.querySelector('form');
    expect(new FormData(form).has('agreement')).toBe(false);
    input.click();
    fixture.detectChanges();
    expect(input.indeterminate).toBe(false);
    expect(fixture.componentInstance.mixed).toBe(false);
    expect(new FormData(form).get('agreement')).toBe('yes');
    fixture.componentInstance.control.setValue(false);
    fixture.detectChanges();
    expect(new FormData(form).has('agreement')).toBe(false);
  });
});
