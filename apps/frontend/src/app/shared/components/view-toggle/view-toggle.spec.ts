import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ViewToggle, type ViewToggleOption } from './view-toggle';

const OPTIONS: readonly ViewToggleOption[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'guilds', label: 'Guilds' },
  { id: 'players', label: 'Players' },
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
    fixture.componentInstance.activeChange.subscribe((id) => emitted.push(id));
    fixture.detectChanges();
    return { fixture, emitted };
  }

  it('renders the segmented view control', async () => {
    const { fixture } = await create();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Overview');
    expect(text).toContain('Guilds');
    expect(fixture.nativeElement.querySelector('[role="tablist"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.toggle-container')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('.toggle-btn').length).toBe(3);
  });

  it('activates the next tab on ArrowRight', async () => {
    const { fixture, emitted } = await create();
    const tablist = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(emitted).toEqual(['guilds']);
  });
});
