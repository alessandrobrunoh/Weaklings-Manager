import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateService } from '../../core/services/translate.service';
import { FightDetailPage } from './fight-detail';

describe('FightDetailPage split review', () => {
  it('associates the review button with the split form and stages the selected battle', async () => {
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    const api = {
      get: vi.fn().mockReturnValue(of({
        id: 12,
        started_at: '2026-01-01T00:00:00Z',
        ended_at: '2026-01-01T01:00:00Z',
        grouping_method: 'manual',
        grouping_confidence: 1,
        needs_review: false,
        battle_ids: ['101', '102'],
      })),
      post: vi.fn(),
    };
    try {
      await TestBed.configureTestingModule({
        imports: [FightDetailPage],
        providers: [
          provideZonelessChangeDetection(),
          provideRouter([]),
          { provide: ApiService, useValue: api },
          { provide: AuthService, useValue: { hasPermission: () => true, profile: () => null } },
          { provide: ThemeService, useValue: { isDark: () => true } },
          TranslateService,
        ],
      }).compileComponents();
      const translations = TestBed.inject(TranslateService);
      translations.use('en');
      const fixture = TestBed.createComponent(FightDetailPage);
      fixture.componentRef.setInput('fightId', '12');
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const page = fixture.componentInstance as unknown as { openSplit: () => void };
      page.openSplit();
      fixture.detectChanges();

      const form: HTMLFormElement = fixture.nativeElement.querySelector('#fight-split-form');
      const review: HTMLButtonElement = fixture.nativeElement.querySelector('button[form="fight-split-form"]');
      expect(form).toBeTruthy();
      expect(review.form).toBe(form);
      form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      review.click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('#fight-split-form')).toBeNull();
      expect(fixture.nativeElement.textContent).toContain(translations.t('fights.confirmTitle'));
      expect(fixture.nativeElement.textContent).toContain('101');
      expect(api.post).not.toHaveBeenCalled();
      fixture.destroy();
    } finally {
      if (showModal) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
      } else {
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      }
    }
  });
});

describe('FightDetailPage friendly side', () => {
  const guild = (id: string, name: string, flags: { is_friendly?: boolean; is_own?: boolean }) => ({
    id,
    name,
    alliance_name: null,
    players: 10,
    kills: 5,
    deaths: 5,
    kill_fame: 1000,
    winner: false,
    ...flags,
  });
  const player = (name: string, guild_name: string, is_friendly: boolean) => ({
    id: '',
    name,
    guild_id: '',
    guild_name,
    alliance_name: null,
    kills: 1,
    deaths: 0,
    kill_fame: 10,
    death_fame: 0,
    item_power: 1000,
    is_friendly,
  });

  it('trusts the backend flags instead of comparing the tenant name', async () => {
    const api = {
      get: vi.fn().mockReturnValue(of({
        id: 12,
        started_at: '2026-01-01T00:00:00Z',
        ended_at: null,
        grouping_method: 'manual',
        grouping_confidence: 1,
        needs_review: false,
        battle_ids: [],
        guilds: [
          // The Discord server is called like the enemy guild, and an ally
          // is flagged friendly without being the tenant's own guild.
          guild('a', 'Night Owls', { is_friendly: true, is_own: true }),
          guild('b', 'Allied Crew', { is_friendly: true }),
          guild('c', 'Discord Server Name', {}),
        ],
        players: [
          player('Hawk', 'Night Owls', true),
          player('Buddy', 'Allied Crew', true),
          player('Foe', 'Discord Server Name', false),
        ],
      })),
      post: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [FightDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ tenant_name: 'Discord Server Name' }) },
        },
        { provide: ThemeService, useValue: { isDark: () => true } },
        TranslateService,
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    const fixture = TestBed.createComponent(FightDetailPage);
    fixture.componentRef.setInput('fightId', '12');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const page = fixture.componentInstance as unknown as {
      ourGuild: () => { name: string } | null;
      enrichedGuilds: () => { name: string; isOurGuild: boolean; isOurAlliance: boolean }[];
      enrichedPlayers: () => { name: string; isOurGuild: boolean; isOurAlliance: boolean }[];
    };
    expect(page.ourGuild()?.name).toBe('Night Owls');
    const byName = <T extends { name: string }>(rows: T[], name: string) => rows.find((row) => row.name === name)!;
    const guilds = page.enrichedGuilds();
    expect(byName(guilds, 'Night Owls')).toMatchObject({ isOurGuild: true, isOurAlliance: true });
    expect(byName(guilds, 'Allied Crew')).toMatchObject({ isOurGuild: false, isOurAlliance: true });
    expect(byName(guilds, 'Discord Server Name')).toMatchObject({ isOurGuild: false, isOurAlliance: false });
    const players = page.enrichedPlayers();
    expect(byName(players, 'Hawk')).toMatchObject({ isOurGuild: true, isOurAlliance: true });
    expect(byName(players, 'Buddy')).toMatchObject({ isOurGuild: false, isOurAlliance: true });
    expect(byName(players, 'Foe')).toMatchObject({ isOurGuild: false, isOurAlliance: false });
    fixture.destroy();
  });
});

describe('FightDetailPage load errors', () => {
  it('shows the not-found state when the API answers 404', async () => {
    const api = {
      get: vi.fn().mockReturnValue(throwError(() => new ApiError(404, 'missing'))),
      post: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [FightDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { hasPermission: () => true, profile: () => null } },
        { provide: ThemeService, useValue: { isDark: () => true } },
        TranslateService,
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    const fixture = TestBed.createComponent(FightDetailPage);
    fixture.componentRef.setInput('fightId', '99');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const page = fixture.componentInstance as unknown as { notFound: () => boolean };
    expect(page.notFound()).toBe(true);
    expect(fixture.nativeElement.querySelector('app-error-state')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
