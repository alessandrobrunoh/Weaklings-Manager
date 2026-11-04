import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { AdminGiveaways } from './admin-giveaways';

describe('AdminGiveaways required fields', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks the required title and end time, while keeping prize inputs optional alternatives', async () => {
    await TestBed.configureTestingModule({
      imports: [AdminGiveaways],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap({}),
            },
          },
        },
        {
          provide: ApiService,
          useValue: {
            get: vi.fn((url: string) =>
              of(url === 'api/giveaways' ? { items: [], total_items: 0 } : []),
            ),
            post: vi.fn(),
            put: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: { hasPermission: (permission: string) => permission === 'giveaways.create' },
        },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        { provide: AlbionCatalogService, useValue: { load: vi.fn().mockResolvedValue([]) } },
      ],
    }).compileComponents();

    const fixture: ComponentFixture<AdminGiveaways> = TestBed.createComponent(AdminGiveaways);
    await fixture.whenStable();
    fixture.detectChanges();

    const form = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'form',
    )[0] as HTMLFormElement;
    expect(form.textContent).toContain('validation.requiredLegend');
    expect(form.querySelectorAll('input[required]')).toHaveLength(2);
    expect(form.querySelectorAll('label [aria-hidden="true"]')).toHaveLength(2);
    expect(form.checkValidity()).toBe(false);
    expect(form.querySelector('input[type="number"][required]')).toBeNull();
    const prizeGroup = form.querySelector(
      'fieldset[aria-describedby="giveaway-prize-requirement"]',
    );
    expect(prizeGroup?.querySelector('legend [aria-hidden="true"]')?.textContent).toBe('*');
    expect(prizeGroup?.querySelector('#giveaway-prize-requirement')?.textContent).toContain(
      'giveaways.needPrize',
    );
    expect(prizeGroup?.querySelector('input[inputmode="numeric"][required]')).toBeNull();
  });
});
