import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Regears } from './regears';

describe('regear queue navigation', () => {
  async function open(tab: string, canAdjudicate: boolean) {
    const params = new BehaviorSubject(convertToParamMap({ tab }));
    const get = vi.fn().mockReturnValue(of({ items: [], total_items: 0 }));
    await TestBed.configureTestingModule({
      imports: [Regears],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: params.value }, queryParamMap: params } },
        { provide: ApiService, useValue: { get } },
        { provide: AuthService, useValue: { hasPermission: (permission: string) => permission === 'regear.adjudicate' && canAdjudicate, profile: () => null } },
        { provide: ToastService, useValue: { error: vi.fn() } },
        TranslateService,
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Regears);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, get, params };
  }

  it('opens the pending global queue for an officer and responds to query changes', async () => {
    const { fixture, get, params } = await open('queue', true);
    expect(get).toHaveBeenCalledWith('api/regear/deaths', expect.objectContaining({ global: true, status: 'pending' }));
    params.next(convertToParamMap({ tab: 'history' }));
    await fixture.whenStable();
    expect(get).toHaveBeenCalledWith('api/regear/deaths', expect.objectContaining({ global: true, history: true }));
    fixture.destroy();
  });

  it('falls back to personal deaths without adjudication permission', async () => {
    const { fixture, get } = await open('queue', false);
    expect(get).toHaveBeenCalledWith('api/regear/deaths', expect.objectContaining({ global: false }));
    expect(get).not.toHaveBeenCalledWith('api/regear/deaths', expect.objectContaining({ global: true }));
    fixture.destroy();
  });

  it('offers a review action for pending queue items to adjudicators', async () => {
    const params = new BehaviorSubject(convertToParamMap({ tab: 'queue' }));
    const death = {
      id: 42,
      event_id: 3,
      event_title: 'CTA',
      event_battle_id: null,
      albionbb_battle_id: 'battle',
      albion_kill_event_id: null,
      source: 'extracted',
      killed_at: '2026-01-01T00:00:00Z',
      user_id: 7,
      player_name: 'Member',
      primary_build_id: null,
      primary_build_name: null,
      loadout_json: {},
      auto_estimate_total: 1200,
      auto_estimate_breakdown: [],
      status: 'pending',
      requested_at: '2026-01-01T00:00:00Z',
      decided_at: null,
      decided_by_user_id: null,
      final_amount: null,
      final_breakdown: null,
      officer_note: null,
      bank_transaction_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const page = { items: [death], total_items: 1 };
    const get = vi.fn().mockReturnValue(of(page));
    await TestBed.configureTestingModule({
      imports: [Regears],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: params.value }, queryParamMap: params } },
        { provide: ApiService, useValue: { get } },
        { provide: AuthService, useValue: { hasPermission: (permission: string) => permission === 'regear.adjudicate', profile: () => null } },
        { provide: ToastService, useValue: { error: vi.fn() } },
        TranslateService,
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Regears);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(get).toHaveBeenCalledWith('api/regear/deaths', expect.objectContaining({ global: true, status: 'pending' }));
    expect(fixture.nativeElement.textContent).toContain('Review request');
    expect(fixture.nativeElement.querySelector('a[href="/regears/42"]')).not.toBeNull();
    fixture.destroy();
  });
});
