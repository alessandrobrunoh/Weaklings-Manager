import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type {
  EventParty,
  EventRosterRole,
  EventRosterView,
} from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import { EventPartyStructure } from './event-party-structure';

function party(id: number, position: number, overrides: Partial<EventParty> = {}): EventParty {
  return {
    id,
    position,
    name: null,
    comp_id: 10 + id,
    active_comp_id: 10 + id,
    comp_name: `Comp ${id}`,
    seat_count: 20,
    filled_count: 5,
    board_party_numbers: [position],
    role_counts: [
      { role: 'dps', count: 14 },
      { role: 'tank', count: 6 },
    ],
    ...overrides,
  };
}

function roster(parties: EventParty[], version = 7): EventRosterView {
  return {
    event_id: 1,
    roster_version: version,
    active_comp_id: parties[0]?.comp_id ?? 0,
    parties,
    seats: [],
    bench: [],
  };
}

interface Handles {
  readonly post: ReturnType<typeof vi.fn>;
  readonly patch: ReturnType<typeof vi.fn>;
  readonly del: ReturnType<typeof vi.fn>;
  readonly success: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
  readonly host: HTMLElement;
  readonly component: StructureInternals;
  readonly changed: ReturnType<typeof vi.fn>;
  readonly detect: () => void;
}

/** The protected members the spec drives directly instead of through the select widget. */
interface StructureInternals {
  setDraftName(party: EventParty, event: Event): void;
  setDraftComp(party: EventParty, compId: string): void;
  save(party: EventParty): Promise<void>;
  move(party: EventParty, direction: -1 | 1): Promise<void>;
  confirmRemoval(party: EventParty): Promise<void>;
  addParty(): Promise<void>;
  newCompId: { set(value: string): void };
  newName: { set(value: string): void };
}

function setup(
  parties: EventParty[],
  options: { extraRoles?: EventRosterRole[]; patchResult?: unknown } = {},
): Handles {
  const post = vi.fn(() => of(roster(parties)));
  const patch = vi.fn(() => options.patchResult ? of(options.patchResult) : of({ roster: roster(parties), unseated_count: 0 }));
  const del = vi.fn(() => of({ roster: roster(parties), unseated_count: 3 }));
  const success = vi.fn();
  const error = vi.fn();
  TestBed.configureTestingModule({
    imports: [EventPartyStructure],
    providers: [
      {
        provide: ApiService,
        useValue: {
          get: vi.fn(() =>
            of({ items: [{ id: 11, name: 'Comp 1' }, { id: 12, name: 'Comp 2' }, { id: 99, name: 'Zerg' }] }),
          ),
          post,
          patch,
          delete: del,
        },
      },
      { provide: ToastService, useValue: { success, error } },
      {
        provide: TranslateService,
        useValue: {
          t: (key: string, params?: Record<string, string | number>) =>
            params ? `${key}:${JSON.stringify(params)}` : key,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(EventPartyStructure);
  fixture.componentRef.setInput('eventId', 1);
  fixture.componentRef.setInput('roster', roster(parties));
  fixture.componentRef.setInput('extraRoles', options.extraRoles ?? []);
  const changed = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  fixture.detectChanges();
  return {
    post,
    patch,
    del,
    success,
    error,
    changed,
    host: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance as unknown as StructureInternals,
    detect: () => fixture.detectChanges(),
  };
}

describe('EventPartyStructure', () => {
  it('renders one card per party plus the add card', () => {
    const { host } = setup([party(1, 1), party(2, 2)]);

    expect(host.querySelectorAll('.structure-card').length).toBe(3);
    expect(host.querySelector('.structure-card--add')).not.toBeNull();
  });

  it('summarises roles in lobby order', () => {
    const { host } = setup([party(1, 1)]);

    const roles = [...host.querySelectorAll('.structure-role')].map((node) =>
      node.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(roles).toEqual(['events.detail.role_tank 6', 'events.detail.role_dps 14']);
  });

  it('lists only the extra roles of the party it is shown on', () => {
    const { host } = setup([party(1, 1), party(2, 2)], {
      extraRoles: [
        { id: 1, build_id: 5, name: 'Extra Tank', is_fill: false, party_id: 1, weapon_key: null },
        { id: 2, build_id: 6, name: 'Extra Healer', is_fill: false, party_id: 2, weapon_key: null },
      ],
    });

    const cards = host.querySelectorAll('article.structure-card:not(.structure-card--add)');
    expect(cards[0].textContent).toContain('Extra Tank');
    expect(cards[0].textContent).not.toContain('Extra Healer');
    expect(cards[1].textContent).toContain('Extra Healer');
  });

  it('disables Remove for the last party only', () => {
    const one = setup([party(1, 1)]);
    const remove = one.host.querySelector<HTMLButtonElement>('.structure-card__remove');
    expect(remove?.disabled).toBe(true);
    TestBed.resetTestingModule();

    const two = setup([party(1, 1), party(2, 2)]);
    const removes = two.host.querySelectorAll<HTMLButtonElement>('.structure-card__remove');
    expect([...removes].map((button) => button.disabled)).toEqual([false, false]);
  });

  it('saves the comp and label with the roster version, clearing an emptied label', async () => {
    const { component, patch, changed, success } = setup([party(1, 1, { name: 'Clap' })]);
    const target = party(1, 1, { name: 'Clap' });

    component.setDraftName(target, { target: { value: '  ' } } as unknown as Event);
    component.setDraftComp(target, '12');
    await component.save(target);

    expect(patch).toHaveBeenCalledWith('api/events/1/parties/1', {
      comp_id: 12,
      name: '',
      expected_roster_version: 7,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith('events.parties.saved');
  });

  it('tells the manager how many members went back to the waiting list', async () => {
    const { component, success } = setup([party(1, 1)], {
      patchResult: { roster: roster([party(1, 1)]), unseated_count: 3 },
    });

    component.setDraftComp(party(1, 1), '12');
    await component.save(party(1, 1));

    expect(success).toHaveBeenCalledWith('events.parties.unseatedMany:{"count":3}');
  });

  it('uses the singular message for one member', async () => {
    const { component, success } = setup([party(1, 1)], {
      patchResult: { roster: roster([party(1, 1)]), unseated_count: 1 },
    });

    component.setDraftComp(party(1, 1), '12');
    await component.save(party(1, 1));

    expect(success).toHaveBeenCalledWith('events.parties.unseatedOne');
  });

  it('reorders by sending every party id in the new order', async () => {
    const { component, post, changed } = setup([party(1, 1), party(2, 2), party(3, 3)]);

    await component.move(party(2, 2), -1);

    expect(post).toHaveBeenCalledWith('api/events/1/parties/order', {
      party_ids: [2, 1, 3],
      expected_roster_version: 7,
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not call the server when moving past either end', async () => {
    const { component, post } = setup([party(1, 1), party(2, 2)]);

    await component.move(party(1, 1), -1);
    await component.move(party(2, 2), 1);

    expect(post).not.toHaveBeenCalled();
  });

  it('removes a party with the roster version and reports the unseated members', async () => {
    const { component, del, success } = setup([party(1, 1), party(2, 2)]);

    await component.confirmRemoval(party(2, 2));

    expect(del).toHaveBeenCalledWith('api/events/1/parties/2', { expected_roster_version: 7 });
    expect(success).toHaveBeenCalledWith('events.parties.removed');
    expect(success).toHaveBeenCalledWith('events.parties.unseatedMany:{"count":3}');
  });

  it('adds a party at the end from the chosen comp and label', async () => {
    const { component, post, success } = setup([party(1, 1)]);

    component.newCompId.set('99');
    component.newName.set(' Brawl ');
    await component.addParty();

    expect(post).toHaveBeenCalledWith('api/events/1/parties', {
      comp_id: 99,
      name: 'Brawl',
      expected_roster_version: 7,
    });
    expect(success).toHaveBeenCalledWith('events.parties.added');
  });

  it('shows the error and still asks the page to refresh when the server refuses', async () => {
    const { component, patch, error, changed } = setup([party(1, 1)]);
    patch.mockReturnValueOnce(throwError(() => new Error('Roster changed')));

    component.setDraftComp(party(1, 1), '12');
    await component.save(party(1, 1));

    expect(error).toHaveBeenCalledWith('Roster changed');
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
