import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Stat, SummaryBand } from './summary-band';

@Component({
  imports: [SummaryBand, Stat],
  template: `
    <app-summary-band ariaLabel="Bank summary" [items]="[{ label: 'Members', value: 12, hint: 'active' }]">
      <app-stat label="Pending" [value]="3" tone="warning" hint="3 waiting" />
      <app-stat label="Balance" [value]="null" />
    </app-summary-band>
  `,
})
class Host {}

describe('SummaryBand', () => {
  async function render(): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('is a named group holding the items and the projected stats', async () => {
    const root = await render();
    const group = root.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Bank summary');
    expect(group.querySelectorAll('app-stat').length).toBe(3);
  });

  it('renders label, value and hint, with a dash for a missing value', async () => {
    const root = await render();
    const stats = Array.from(root.querySelectorAll('app-stat'));
    expect(stats[0].textContent).toContain('Members');
    expect(stats[0].textContent).toContain('12');
    expect(stats[0].textContent).toContain('active');
    expect(stats[2].querySelector('.stat__value')?.textContent?.trim()).toBe('—');
  });

  it('exposes the tone as a data attribute and keeps the state in words', async () => {
    const root = await render();
    const pending = root.querySelectorAll('app-stat')[1];
    expect(pending.getAttribute('data-tone')).toBe('warning');
    expect(pending.querySelector('.stat__hint')?.textContent).toContain('3 waiting');
  });
});
