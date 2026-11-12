import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { RegearNewRequest } from './regear-new-request';

const event = {
  event_id: 3,
  event_title: 'CTA',
  primary_build_id: 11,
  primary_build_name: 'Frontline',
  secondary_build_id: null,
  secondary_build_name: null,
  comp_id: 1,
  comp_builds: [
    { build_id: 11, build_name: 'Frontline', quantity: 1 },
    { build_id: 12, build_name: 'Backline', quantity: 2 },
  ],
};

const summary = { weekly_balance: 2, weekly_cap: 3, bonus_balance: 0, bonus_cap: 5 };

function apiGet(events: unknown[] | Error) {
  return vi.fn((url: string) => {
    if (url === 'api/regear/self-service/events') {
      return events instanceof Error ? throwError(() => events) : of(events);
    }
    if (url === 'api/regear/me/summary') {
      return of(summary);
    }
    if (url === 'api/comps/builds/11') {
      return of({ id: 11, name: 'Frontline', items: [] });
    }
    return throwError(() => new Error(`unexpected request ${url}`));
  });
}

async function setup(get: ReturnType<typeof apiGet>, post = vi.fn((_url: string, _body: unknown) => of({ id: 9 }))) {
  await TestBed.configureTestingModule({
    imports: [RegearNewRequest],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: { get, post } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: AlbionCatalogService, useValue: { load: vi.fn().mockResolvedValue([]) } },
      TranslateService,
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(RegearNewRequest);
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
  return fixture;
}

describe('regear new request', () => {
  it('offers events and builds as radio groups with the sign-up build preselected', async () => {
    const fixture = await setup(apiGet([event]));
    const root: HTMLElement = fixture.nativeElement;

    const eventRadios = root.querySelectorAll<HTMLInputElement>('input[name="regear-event"]');
    expect(eventRadios).toHaveLength(1);
    expect(eventRadios[0].checked).toBe(true);

    const buildRadios = root.querySelectorAll<HTMLInputElement>('input[name="regear-build"]');
    expect(buildRadios).toHaveLength(2);
    expect(buildRadios[0].checked).toBe(true);
    expect(buildRadios[1].checked).toBe(false);
    fixture.destroy();
  });

  it('submits the chosen event and build, then opens the new request', async () => {
    const post = vi.fn((_url: string, _body: unknown) => of({ id: 9 }));
    const fixture = await setup(apiGet([event]), post);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await (fixture.componentInstance as unknown as { submit: () => Promise<void> }).submit();

    expect(post).toHaveBeenCalledWith('api/regear/self-service', {
      event_id: 3,
      build_id: 11,
      item_overrides: [],
    });
    expect(navigate).toHaveBeenCalledWith(['/regears', 9]);
    fixture.destroy();
  });

  it('shows a translated error state instead of the raw API message', async () => {
    const fixture = await setup(apiGet(new Error('raw server text')));
    const text: string = fixture.nativeElement.textContent;

    expect(text).not.toContain('raw server text');
    expect(text).toContain('Something went wrong.');
    fixture.destroy();
  });
});
