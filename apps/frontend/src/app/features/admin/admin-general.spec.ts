import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
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
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  const host = () => fixture.nativeElement as HTMLElement;

  const hexInputs = () => Array.from(host().querySelectorAll<HTMLInputElement>('.slot__hex'));

  const saveButton = () => host().querySelector<HTMLButtonElement>('button[type="submit"]');

  const type = async (index: number, value: string) => {
    const input = hexInputs()[index];
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const submit = async () => {
    host().querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    put = vi.fn().mockReturnValue(of({ primary: '#22c55e', secondary: null, tertiary: null }));
    branding = { preview: vi.fn(), clearPreview: vi.fn() };
    toasts = { success: vi.fn(), error: vi.fn() };

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
        { provide: ToastService, useValue: toasts },
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

  it('labels every colour input and marks the section as affecting members', () => {
    expect(hexInputs()[0].labels?.[0]?.textContent?.trim()).toBe('admin.general.primary');
    expect(host().textContent).toContain('admin.general.affectsMembers');
  });

  it('keeps save disabled until something changes', async () => {
    expect(saveButton()?.disabled).toBe(true);
    await type(0, '#22c55e');
    expect(saveButton()?.disabled).toBe(false);
  });

  it('previews every edit so the colour can be judged in place', async () => {
    await type(0, '#22c55e');
    expect(branding.preview).toHaveBeenCalledWith(
      expect.objectContaining({ primary: '#22c55e' }),
    );
  });

  it('refuses to save a colour that is not a hex value', async () => {
    await type(0, 'not-a-colour');
    expect(saveButton()?.disabled).toBe(true);
    expect(host().querySelector('[role="alert"]')).not.toBeNull();
    expect(hexInputs()[0].getAttribute('aria-invalid')).toBe('true');
  });

  /** Omitting a field would keep the old colour; `""` is the API's "clear it". */
  it('sends an empty string for a slot put back on the default', async () => {
    await type(0, '');
    await submit();

    expect(put).toHaveBeenCalledWith('api/admin/branding', {
      primary: '',
      secondary: '',
      tertiary: '',
    });
  });

  it('reports the saved state after a successful save', async () => {
    await type(0, '#22c55e');
    await submit();

    expect(host().textContent).toContain('admin.general.stateSaved');
    expect(toasts.success).toHaveBeenCalledWith('admin.general.saved');
    expect(saveButton()?.disabled).toBe(true);
  });

  it('shows a translated error and keeps the draft when save fails', async () => {
    put.mockReturnValue(throwError(() => new Error('raw api text')));
    await type(0, '#22c55e');
    await submit();

    expect(host().textContent).toContain('admin.general.saveError');
    expect(host().textContent).not.toContain('raw api text');
    expect(toasts.error).toHaveBeenCalledWith('admin.general.saveError');
    expect(hexInputs()[0].value).toBe('#22c55e');
  });

  it('drops the preview when the admin navigates away with unsaved edits', async () => {
    await type(0, '#22c55e');
    fixture.destroy();
    expect(branding.clearPreview).toHaveBeenCalled();
  });

  it('keeps the saved colours painted when the admin leaves after saving', async () => {
    await type(0, '#22c55e');
    await submit();
    fixture.destroy();
    expect(branding.clearPreview).not.toHaveBeenCalled();
  });
});
