import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { RegisterTenant } from './register-tenant';

describe('RegisterTenant', () => {
  let fixture: ComponentFixture<RegisterTenant>;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let attachable: { id: string; name: string }[];

  beforeEach(async () => {
    attachable = [];
    api = {
      get: vi.fn().mockImplementation((url: string) => {
        if (url === 'api/tenants/attachable-guilds') {
          return of(attachable);
        }
        return of({ id: 'g1', registered: false, register_url: null, name: null, status: null });
      }),
      post: vi.fn().mockReturnValue(of({ registered: true })),
    };

    await TestBed.configureTestingModule({
      imports: [RegisterTenant],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        {
          provide: AuthService,
          useValue: {
            profile: () => ({ id: 'u1', is_platform_admin: false }),
            load: () => Promise.resolve({ id: 'u1' }),
            switchTenant: vi.fn().mockResolvedValue({}),
          },
        },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ guild: 'g1' }) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RegisterTenant);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('shows the guild id and starts the wizard', () => {
    expect(api.get).toHaveBeenCalledWith('api/tenants/g1/status');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('g1');
    expect(compiled.textContent).toContain('register.title');
    expect(compiled.querySelector('#tenant-display-name')).toBeTruthy();
  });

  it('marks the required name and enforces native validation', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const form = compiled.querySelector('form') as HTMLFormElement;
    const name = compiled.querySelector('#tenant-display-name') as HTMLInputElement;
    expect(compiled.textContent).toContain('validation.requiredLegend');
    expect(name.required).toBe(true);
    expect(name.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
    expect(form.checkValidity()).toBe(false);
    name.value = 'Guild';
    expect(form.checkValidity()).toBe(true);
  });

  it('lets the officer pick guild or alliance on step 1', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('#kind-guild')).toBeTruthy();
    expect(compiled.querySelector('#kind-alliance')).toBeTruthy();
    expect(compiled.textContent).toContain('register.kind.guild');
    expect(compiled.textContent).toContain('register.kind.alliance');
  });

  it('blocks the albion wizard when alliance is selected', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const name = compiled.querySelector('#tenant-display-name') as HTMLInputElement;
    name.value = 'Hub';
    name.dispatchEvent(new Event('input'));
    const alliance = compiled.querySelector('#kind-alliance') as HTMLInputElement;
    alliance.click();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('register.allianceNeedsGuilds');
    expect((compiled.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      true,
    );

    compiled.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    fixture.detectChanges();
    expect(compiled.querySelector('#albion-guild-search')).toBeNull();
    expect(compiled.querySelector('#member-guild-a')).toBeNull();
  });

  it('lets the officer pick member guilds when alliance has attachable tenants', async () => {
    attachable = [{ id: 'guild-a', name: 'Alpha Guild' }];
    fixture.destroy();
    fixture = TestBed.createComponent(RegisterTenant);
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const name = compiled.querySelector('#tenant-display-name') as HTMLInputElement;
    name.value = 'Hub';
    name.dispatchEvent(new Event('input'));
    const alliance = compiled.querySelector('#kind-alliance') as HTMLInputElement;
    alliance.click();
    fixture.detectChanges();

    expect(compiled.textContent).not.toContain('register.allianceNeedsGuilds');
    expect((compiled.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );

    compiled.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    fixture.detectChanges();
    expect(compiled.querySelector('#albion-guild-search')).toBeNull();
    expect(compiled.querySelector('#member-guild-a')).toBeTruthy();
    expect(compiled.textContent).toContain('Alpha Guild');
    const checkbox = compiled.querySelector('#member-guild-a') as HTMLInputElement;
    expect(checkbox.closest('app-checkbox')).toBeTruthy();
    expect(checkbox.required).toBe(false);
    expect(compiled.querySelector('fieldset[aria-describedby="member-guilds-hint"] legend')?.textContent).toContain('*');
    expect((compiled.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    checkbox.click();
    fixture.detectChanges();
    expect((compiled.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('continues to albion setup when guild is selected', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const name = compiled.querySelector('#tenant-display-name') as HTMLInputElement;
    name.value = 'My Guild';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    compiled.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    fixture.detectChanges();
    expect(compiled.querySelector('#albion-guild-search')).toBeTruthy();
  });

  it('drops a picked guild when the region changes and ignores a stale search', async () => {
    vi.useFakeTimers();
    try {
    const first = new Subject<{ guilds: { id: string; name: string }[] }>();
    const second = new Subject<{ guilds: { id: string; name: string }[] }>();
    api.get.mockImplementation((url: string, params?: { q?: string }) => {
      if (url === 'api/tenants/albion-search' && params?.q === 'old') {
        return first.asObservable();
      }
      if (url === 'api/tenants/albion-search' && params?.q === 'new') {
        return second.asObservable();
      }
      if (url === 'api/tenants/attachable-guilds') {
        return of(attachable);
      }
      return of({ id: 'g1', registered: false, register_url: null, name: null, status: null });
    });

    const compiled = fixture.nativeElement as HTMLElement;
    const name = compiled.querySelector('#tenant-display-name') as HTMLInputElement;
    name.value = 'My Guild';
    name.dispatchEvent(new Event('input'));
    compiled.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    fixture.detectChanges();

    const search = compiled.querySelector('#albion-guild-search') as HTMLInputElement;
    search.value = 'old';
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);

    search.value = 'new';
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);

    first.next({ guilds: [{ id: 'stale', name: 'Stale Guild' }] });
    first.complete();
    second.next({ guilds: [{ id: 'fresh', name: 'Fresh Guild' }] });
    second.complete();
    await Promise.resolve();
    fixture.detectChanges();

    expect(compiled.textContent).toContain('Fresh Guild');
    expect(compiled.textContent).not.toContain('Stale Guild');

    const hit = [...compiled.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Fresh Guild'),
    ) as HTMLButtonElement;
    hit.click();
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Fresh Guild');

    const americas = compiled.querySelector('#region-americas') as HTMLInputElement;
    americas.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const next = compiled.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
