import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntelRoster, IntelRosterMember } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { IntelPeriodState } from './intel-period';
import { IntelPlayersPage } from './intel-players';

function member(over: Partial<IntelRosterMember>): IntelRosterMember {
  return {
    user_id: 1,
    username: 'alice',
    albion_name: 'AliceAlbion',
    role: 'Member',
    is_officer: false,
    active: true,
    linked: true,
    fights: 8,
    attendance_rate: 80,
    wins: 5,
    losses: 3,
    draws: 0,
    win_rate: 62.5,
    kills: 20,
    deaths: 10,
    kd_ratio: 2,
    kill_fame: 500_000,
    death_fame: 200_000,
    avg_item_power: 1400,
    weapons: [{ weapon: 'T8_2H_HAMMER', count: 5 }],
    main_role: 'tank',
    last_fight_at: '2026-11-10T19:00:00Z',
    last_fight_id: 9,
    ...over,
  };
}

function roster(over: Partial<IntelRoster> = {}): IntelRoster {
  return {
    period: { key: '30d', from: '2026-10-13T00:00:00Z', to: '2026-11-12T00:00:00Z' },
    total_fights: 10,
    scope: 'all',
    members: [
      member({}),
      member({ user_id: 2, username: 'bob', albion_name: null, linked: false, fights: 0, win_rate: null, kd_ratio: null, attendance_rate: null, weapons: [], main_role: null, last_fight_at: null, last_fight_id: null }),
    ],
    unlinked_players: [{ name: 'StrangerOne', fights: 3 }],
    ...over,
  };
}

async function settle(fixture: ComponentFixture<IntelPlayersPage>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
  fixture.detectChanges();
}

describe('IntelPlayersPage', () => {
  let fixture: ComponentFixture<IntelPlayersPage>;
  let rosterCall: ReturnType<typeof vi.fn>;
  let permissions: Set<string>;

  async function mount(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [IntelPlayersPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        IntelPeriodState,
        { provide: IntelService, useValue: { roster: rosterCall } },
        {
          provide: AuthService,
          useValue: {
            hasPermission: (permission: string) => permissions.has(permission),
            profile: () => ({ user_id: 1 }),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(IntelPlayersPage);
  }

  beforeEach(() => {
    permissions = new Set(['intel.view', 'intel.report.view']);
    rosterCall = vi.fn().mockReturnValue(of(roster()));
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('lists every member for an officer and links to their pages', async () => {
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('alice');
    expect(text).toContain('bob');
    expect(text).toContain('62.5%');
    expect(text).toContain('Hammer');
    expect(text).not.toContain('You can see your own record here.');
    const links = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links.some((link) => link.getAttribute('href')?.startsWith('/intel/players/2'))).toBe(true);
  });

  it('shows a dash, not 0%, for a member with no fights', async () => {
    await mount();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('No fights');
  });

  it('lists characters seen in fights but not linked to a member', async () => {
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Characters not linked to a member');
    expect(text).toContain('StrangerOne');
  });

  it('tells a member they only see themselves and links only their own row', async () => {
    permissions = new Set(['intel.view']);
    rosterCall.mockReturnValue(of(roster({ scope: 'self', members: [member({})], unlinked_players: [] })));
    await mount();
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('You can see your own record here.');
    expect(text).not.toContain('Characters not linked to a member');
    const links = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links.some((link) => link.getAttribute('href')?.startsWith('/intel/players/1'))).toBe(true);
  });

  it('does not link another member to someone without the officer permission', async () => {
    permissions = new Set(['intel.view']);
    await mount();
    await settle(fixture);
    const links = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links.some((link) => link.getAttribute('href')?.startsWith('/intel/players/2'))).toBe(false);
  });
});
