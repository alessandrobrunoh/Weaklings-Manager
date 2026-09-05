import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioUnitGroup } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import { TimelineSpellLibrary } from './timeline-spell-library';

const GROUPS: ScenarioUnitGroup[] = [
  {
    id: 'ally',
    side: 'ally',
    label: 'Polehammer',
    item_id: '2H_POLEHAMMER',
    count: 1,
    hit_points: 1200,
  },
  { id: 'bare', side: 'enemy', label: 'No weapon', item_id: null, count: 1, hit_points: 1200 },
];

const SLOTS = {
  ally: [
    { label: 'Q', choices: [{ id: 'WHIRL', name: 'Earth Shatter', cooldown: '15s' }] },
    { label: 'W', choices: [{ id: 'SMASH', name: 'Shocking Smash', cooldown: null }] },
  ],
};

describe('TimelineSpellLibrary', () => {
  let fixture: ComponentFixture<TimelineSpellLibrary>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelineSpellLibrary],
      providers: [provideZonelessChangeDetection(), TranslateService],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(TimelineSpellLibrary);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.componentRef.setInput('slotsByGroup', SLOTS);
    fixture.componentRef.setInput('canManage', true);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function entries(): HTMLButtonElement[] {
    return [...fixture.nativeElement.querySelectorAll('.library-entry')] as HTMLButtonElement[];
  }

  it('lists every ability of a group that has a weapon, and nothing for one that does not', () => {
    expect(entries().map((entry) => entry.textContent?.trim())).toHaveLength(2);
    expect(fixture.nativeElement.textContent).toContain('Earth Shatter');
    expect(fixture.nativeElement.textContent).not.toContain('No weapon');
  });

  it('shows a cooldown only when the catalog states one', () => {
    expect(entries()[0].textContent).toContain('15s');
    expect(entries()[1].querySelector('.library-cooldown')).toBeNull();
  });

  it('is draggable and, equivalently, activatable from the keyboard', () => {
    const added = vi.fn();
    fixture.componentInstance.addRequested.subscribe(added);
    expect(entries()[0].getAttribute('draggable')).toBe('true');
    entries()[0].click();
    expect(added).toHaveBeenCalledWith({ casterGroupId: 'ally', spellId: 'WHIRL' });
  });

  it('points at the Setup tab when no group has a weapon yet', async () => {
    fixture.componentRef.setInput('slotsByGroup', {});
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Pick a weapon for a group in Setup');
  });

  it('offers nothing to drag without permission', async () => {
    fixture.componentRef.setInput('canManage', false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(entries()[0].disabled).toBe(true);
    expect(entries()[0].getAttribute('draggable')).toBe('false');
  });
});
