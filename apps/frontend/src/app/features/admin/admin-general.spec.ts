import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { BrandingService } from '../../core/services/branding.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminGeneral } from './admin-general';

describe('AdminGeneral', () => {
  let fixture: ComponentFixture<AdminGeneral>;
  let put: ReturnType<typeof vi.fn>;
  let branding: { preview: ReturnType<typeof vi.fn>; clearPreview: ReturnType<typeof vi.fn> };

  const hexInputs = () =>
    Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('.slot__hex'),
    );

  const type = async (index: number, value: string) => {
    const input = hexInputs()[index];
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    put = vi.fn().mockReturnValue(of({ primary: '#22c55e', secondary: null, tertiary: null }));
    branding = { preview: vi.fn(), clearPreview: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AdminGeneral],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            get: () => of({ primary: '#dc2626', secondary: null, tertiary: null }),
            put,
          },
        },
        { provide: BrandingService, useValue: branding },
        { provide: AuthService, useValue: { profile: signal({ tenant_name: 'Weaklings' }) } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminGeneral);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads the saved colours into the form', () => {
    expect(hexInputs()[0].value).toBe('#dc2626');
    expect(hexInputs()[1].value).toBe('');
  });

  it('previews every edit so the colour can be judged in place', async () => {
    await type(0, '#22c55e');
    expect(branding.preview).toHaveBeenCalledWith(
      expect.objectContaining({ primary: '#22c55e' }),
    );
  });

  it('refuses to save a colour that is not a hex value', async () => {
    await type(0, 'not-a-colour');
    const save = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(save?.disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull();
  });

  /** Omitting a field would keep the old colour; `""` is the API's "clear it". */
  it('sends an empty string for a slot put back on the default', async () => {
    await type(0, '');
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLFormElement>('form')
      ?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    expect(put).toHaveBeenCalledWith('api/admin/branding', {
      primary: '',
      secondary: '',
      tertiary: '',
    });
  });

  it('drops the preview when the admin navigates away unsaved', () => {
    fixture.destroy();
    expect(branding.clearPreview).toHaveBeenCalled();
  });
});
