import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
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
