import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ViewToggle, type ViewToggleOption } from './view-toggle';

const OPTIONS: readonly ViewToggleOption[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'guilds', label: 'Guilds', badge: 3 },
  { id: 'players', label: 'Players', badge: 12, dot: 'success' },
];

describe('ViewToggle', () => {
  async function create(active = 'overview'): Promise<{
    fixture: ComponentFixture<ViewToggle>;
    emitted: string[];
  }> {
    const emitted: string[] = [];
    await TestBed.configureTestingModule({
      imports: [ViewToggle],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    const fixture = TestBed.createComponent(ViewToggle);
    fixture.componentRef.setInput('options', OPTIONS);
    fixture.componentRef.setInput('active', active);
    fixture.componentRef.setInput('ariaLabel', 'Views');
    fixture.componentInstance.activeChange.subscribe((id) => emitted.push(id));
    fixture.detectChanges();
    return { fixture, emitted };
  }

  it('renders the events-style tabs with badges', async () => {
    const { fixture } = await create();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Overview');
    expect(text).toContain('Guilds');
    expect(text).toContain('3');
    expect(fixture.nativeElement.querySelector('[role="tablist"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.toggle-container')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.tab').length).toBe(3);
  });

  it('activates the next tab on ArrowRight', async () => {
    const { fixture, emitted } = await create();
    const tablist = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(emitted).toEqual(['guilds']);
  });
});
