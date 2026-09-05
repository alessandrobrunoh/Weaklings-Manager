import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ScenarioDeclaredCast,
  ScenarioDefinition,
  ScenarioResult,
  ScenarioUnitGroup,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import { TimelineEditor } from './timeline-editor';

const PX_PER_SECOND = 80; // the default zoom level

function group(id: string, overrides: Partial<ScenarioUnitGroup> = {}): ScenarioUnitGroup {
  return { id, side: 'ally', label: id, item_id: null, count: 1, hit_points: 1200, ...overrides };
}

function cast(
  casterGroupId: string,
  spellId: string,
  castAt: number,
  overrides: Partial<ScenarioDeclaredCast> = {},
): ScenarioDeclaredCast {
  return {
    caster_group_id: casterGroupId,
    spell_id: spellId,
    cast_at: castAt,
    target_ids: [],
    attacker_style: 'melee',
    ...overrides,
  };
}

const DEFINITION: ScenarioDefinition = {
  groups: [group('ally-hammer', { label: 'Polehammer' }), group('enemy-plate', { side: 'enemy', label: 'Guardian', count: 2 })],
  casts: [cast('ally-hammer', 'WHIRL', 1, { target_ids: ['enemy-plate#0'] })],
};

describe('TimelineEditor', () => {
  let fixture: ComponentFixture<TimelineEditor>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelineEditor],
      providers: [provideZonelessChangeDetection(), TranslateService],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(TimelineEditor);
    fixture.componentRef.setInput('definition', DEFINITION);
    fixture.componentRef.setInput('canManage', true);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function clips(): HTMLButtonElement[] {
    return [...fixture.nativeElement.querySelectorAll('[data-cast-index]')] as HTMLButtonElement[];
  }

  function lanes(): HTMLElement[] {
    return [...fixture.nativeElement.querySelectorAll('[data-lane-index]')] as HTMLElement[];
  }

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('renders one lane per unit group and one clip per cast', () => {
    expect(lanes()).toHaveLength(2);
    expect(clips()).toHaveLength(1);
    expect(clips()[0].getAttribute('aria-label')).toContain('WHIRL');
    expect(clips()[0].getAttribute('aria-label')).toContain('1.0 s');
  });

  it('describes the timeline region for assistive technology', () => {
    const scroller = fixture.nativeElement.querySelector('.timeline-scroller') as HTMLElement;
    expect(scroller.getAttribute('role')).toBe('group');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('aria-describedby')).toBe('timeline-instructions');
  });

  describe('keyboard', () => {
    it('nudges a cast by a tenth of a second', () => {
      const moved = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      clips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(moved).toHaveBeenCalledWith({
        index: 0,
        castAt: 1.1,
        casterGroupId: 'ally-hammer',
      });
    });

    it('nudges by a whole second with Shift', () => {
      const moved = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      clips()[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }),
      );
      expect(moved).toHaveBeenCalledWith({ index: 0, castAt: 0, casterGroupId: 'ally-hammer' });
    });

    it('clamps at zero rather than going negative', () => {
      const moved = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      clips()[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      clips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      expect(moved.mock.calls.every(([event]) => event.castAt >= 0)).toBe(true);
    });

    it('moves a cast to the next lane with the down arrow', () => {
      const moved = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      clips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(moved).toHaveBeenCalledWith({ index: 0, castAt: 1, casterGroupId: 'enemy-plate' });
    });

    it('removes a cast with Delete and says so', async () => {
      const removed = vi.fn();
      fixture.componentInstance.castRemoved.subscribe(removed);
      clips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await settle();
      expect(removed).toHaveBeenCalledWith(0);
      const live = fixture.nativeElement.querySelector('[aria-live="polite"]') as HTMLElement;
      expect(live.textContent).toContain('WHIRL');
    });

    it('does nothing at all without permission', async () => {
      fixture.componentRef.setInput('canManage', false);
      await settle();
      const moved = vi.fn();
      const removed = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      fixture.componentInstance.castRemoved.subscribe(removed);
      clips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      clips()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      expect(moved).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
    });
  });

  describe('lanes', () => {
    it('expands into one sub-row per unit instance', async () => {
      const toggles = [
        ...fixture.nativeElement.querySelectorAll('.lane-toggle'),
      ] as HTMLButtonElement[];
      expect(toggles[1].getAttribute('aria-expanded')).toBe('false');
      toggles[1].click();
      await settle();
      expect(toggles[1].getAttribute('aria-expanded')).toBe('true');
      expect(fixture.nativeElement.querySelectorAll('.subrow')).toHaveLength(2);
    });
  });

  describe('zoom', () => {
    it('widens the track as it zooms in', async () => {
      const track = () =>
        (fixture.nativeElement.querySelector('[data-track]') as HTMLElement).style.width;
      const before = track();
      const zoomIn = fixture.nativeElement.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement;
      zoomIn.click();
      await settle();
      expect(Number.parseFloat(track())).toBeCloseTo(Number.parseFloat(before) * 2, 5);
    });
  });

  describe('pointer drag', () => {
    /**
     * jsdom returns an all-zero rect, which is exactly the coordinate space the arithmetic assumes
     * (track left edge at 0), so a click x maps straight onto `x / pxPerSecond` seconds.
     */
    function press(clip: HTMLElement, clientX: number, clientY = 0): void {
      clip.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX, clientY }),
      );
    }

    function move(clientX: number, clientY = 0): void {
      document.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX, clientY }),
      );
    }

    function release(clientX: number, clientY = 0): void {
      document.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX, clientY }),
      );
    }

    it('moves the cast to where the pointer let go', async () => {
      const moved = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      press(clips()[0], 100);
      move(100 + 2 * PX_PER_SECOND);
      await settle();
      release(100 + 2 * PX_PER_SECOND);
      expect(moved).toHaveBeenCalledWith({ index: 0, castAt: 2, casterGroupId: 'ally-hammer' });
    });

    it('treats a press that barely moved as a selection, not a drag', async () => {
      const moved = vi.fn();
      const selected = vi.fn();
      fixture.componentInstance.castMoved.subscribe(moved);
      fixture.componentInstance.castSelected.subscribe(selected);
      press(clips()[0], 100);
      move(102);
      await settle();
      release(102);
      clips()[0].click();
      expect(moved).not.toHaveBeenCalled();
      expect(selected).toHaveBeenCalledWith(0);
    });

    it('does not throw where pointer capture is unavailable', () => {
      expect(() => press(clips()[0], 100)).not.toThrow();
      release(100);
    });
  });

  describe('dropping a spell from the library', () => {
    /**
     * jsdom implements neither `DragEvent` nor `DataTransfer`, so the handler is called with the
     * shape it reads — the same approach the roster drag specs take.
     */
    function dragEvent(clientX: number, payload: unknown): DragEvent {
      return {
        clientX,
        currentTarget: fixture.nativeElement.querySelector('[data-track]'),
        preventDefault: vi.fn(),
        dataTransfer: { getData: () => JSON.stringify(payload), dropEffect: '' },
      } as unknown as DragEvent;
    }

    it('adds a cast at the snapped time it was dropped on', () => {
      const created = vi.fn();
      fixture.componentInstance.castCreated.subscribe(created);
      const editor = fixture.componentInstance as unknown as {
        onDrop(event: DragEvent, laneIndex: number): void;
      };
      editor.onDrop(
        dragEvent(3 * PX_PER_SECOND + 3, { kind: 'spell', casterGroupId: 'x', spellId: 'SMASH' }),
        1,
      );
      expect(created).toHaveBeenCalledWith({
        casterGroupId: 'enemy-plate',
        spellId: 'SMASH',
        castAt: 3,
      });
    });

    it('ignores a payload that is not one of ours', () => {
      const created = vi.fn();
      fixture.componentInstance.castCreated.subscribe(created);
      const editor = fixture.componentInstance as unknown as {
        onDrop(event: DragEvent, laneIndex: number): void;
      };
      editor.onDrop(dragEvent(0, { some: 'other app' }), 0);
      expect(created).not.toHaveBeenCalled();
    });
  });

  describe('run overlay', () => {
    const RESULT: ScenarioResult = {
      units: [
        {
          id: 'enemy-plate#0',
          group_id: 'enemy-plate',
          group_label: 'Guardian',
          side: 'enemy',
          starting_hp: 1200,
          damage_taken: 1200,
          healing_received: 0,
          remaining_hp: 0,
          died_at: 3.4,
        },
        {
          id: 'enemy-plate#1',
          group_id: 'enemy-plate',
          group_label: 'Guardian',
          side: 'enemy',
          starting_hp: 1200,
          damage_taken: 0,
          healing_received: 0,
          remaining_hp: 1200,
          died_at: null,
        },
      ],
      casts: [
        {
          caster_group_id: 'ally-hammer',
          spell_id: 'WHIRL',
          land_at: 3.4,
          target_ids: ['enemy-plate#0'],
          concurrent_attackers: 1,
          prior_cc_stacks: 0,
          escalation_multiplier: 1,
          focus_fire_reduction: 0,
          per_target_health_change: -1200,
          crowd_control: [],
          unsupported: [],
        },
      ],
      total_damage_dealt: 1200,
      total_healing_done: 0,
      deaths: 1,
      average_time_to_kill: 3.4,
      overkill_ratio: 0,
      unknown_spells: [],
      casts_with_no_targets: [],
    };

    beforeEach(async () => {
      fixture.componentRef.setInput('result', RESULT);
      await settle();
      const toggles = [
        ...fixture.nativeElement.querySelectorAll('.lane-toggle'),
      ] as HTMLButtonElement[];
      toggles[1].click();
      await settle();
    });

    it('marks where a unit died', () => {
      const death = fixture.nativeElement.querySelector('.subrow__death') as HTMLElement;
      expect(death.getAttribute('aria-label')).toContain('3.4 s');
    });

    it('names the units no cast ever targets', () => {
      expect(fixture.nativeElement.textContent).toContain('enemy-plate#1');
    });

    it('offers to re-run when the results predate the draft', async () => {
      const requested = vi.fn();
      fixture.componentInstance.runRequested.subscribe(requested);
      fixture.componentRef.setInput('staleResult', true);
      await settle();
      const chip = fixture.nativeElement.querySelector('.chip--warning') as HTMLElement;
      expect(chip.textContent).toContain('before your last edit');
      (chip.querySelector('button') as HTMLButtonElement).click();
      expect(requested).toHaveBeenCalled();
    });

    it('drops the overlay when the run is hidden', async () => {
      const checkbox = fixture.nativeElement.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement;
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change'));
      await settle();
      expect(fixture.nativeElement.querySelector('.subrow__death')).toBeNull();
    });
  });

  describe('orphaned casts', () => {
    it('gives casts whose group is gone a lane of their own', async () => {
      fixture.componentRef.setInput('definition', {
        groups: [group('ally-hammer')],
        casts: [cast('renamed-away', 'WHIRL', 1)],
      });
      await settle();
      expect(fixture.nativeElement.textContent).toContain('Casts with no matching group');
      expect(clips()).toHaveLength(1);
    });
  });
});
