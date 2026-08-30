import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { Dialog } from './dialog';

function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') {
    return;
  }
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    Object.defineProperty(this, 'open', { configurable: true, get: () => true });
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    Object.defineProperty(this, 'open', { configurable: true, get: () => false });
    this.dispatchEvent(new Event('close'));
  };
}

describe('Dialog', () => {
  let fixture: ComponentFixture<Dialog>;

  beforeEach(async () => {
    stubDialogApi();
    await TestBed.configureTestingModule({
      imports: [Dialog],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(Dialog);
    fixture.componentRef.setInput('title', 'Create event');
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('opens a native dialog with the given title', () => {
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('h2')?.textContent).toContain('Create event');
    expect(dialog.hasAttribute('closedby')).toBe(true);
  });

  it('emits closed when the close button is pressed', () => {
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const button = fixture.nativeElement.querySelector('button[aria-label]') as HTMLButtonElement;
    button.click();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
