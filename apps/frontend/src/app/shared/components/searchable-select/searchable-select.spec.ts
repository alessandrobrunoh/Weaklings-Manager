import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { SearchableSelect } from './searchable-select';

describe('SearchableSelect', () => {
  let fixture: ComponentFixture<SearchableSelect>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SearchableSelect],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(SearchableSelect);
    fixture.componentRef.setInput('options', [
      { id: 'a', label: 'Announcements' },
      { id: 'b', label: 'Officers' },
    ]);
    fixture.componentRef.setInput('emptyLabel', 'Disabled');
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('keeps a saved value even before the list is opened', () => {
    fixture.componentRef.setInput('value', 'b');
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('.ss__trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Officers');
    expect(trigger.textContent).not.toContain('Disabled');
  });

  it('filters options from the search field', async () => {
    const trigger = fixture.nativeElement.querySelector('.ss__trigger') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const search = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    search.value = 'off';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const labels = [...fixture.nativeElement.querySelectorAll('.ss__option')].map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(labels).toContain('Officers');
    expect(labels).not.toContain('Announcements');
  });
});
