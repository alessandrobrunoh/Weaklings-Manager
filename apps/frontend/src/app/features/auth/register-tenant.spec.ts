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

  beforeEach(async () => {
    api = {
      get: vi.fn().mockReturnValue(
        of({ id: 'g1', registered: false, register_url: null, name: null, status: null }),
      ),
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
});
