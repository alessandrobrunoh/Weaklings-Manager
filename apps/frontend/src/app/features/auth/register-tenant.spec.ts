import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
});
