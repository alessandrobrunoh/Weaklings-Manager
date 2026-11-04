import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Battles } from './battles';

describe('Battles task-first scope labels', () => {
  it('distinguishes canonical guild fights from personal raw battles', async () => {
    await TestBed.configureTestingModule({
      imports: [Battles],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: { get: () => of({ items: [], total_items: 0 }) } },
        { provide: ToastService, useValue: { error: () => undefined } },
        TranslateService,
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');

    const fixture = TestBed.createComponent(Battles);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Grouped guild fights');
    expect(fixture.nativeElement.textContent).toContain('canonical guild fight');
    expect(fixture.nativeElement.querySelector('a[routerLink="/fights/trends"]')).not.toBeNull();

    const component = fixture.componentInstance as unknown as { switchTab(tab: string): void };
    component.switchTab('me');
    fixture.detectChanges();

    const translations = TestBed.inject(TranslateService);
    const expectedPersonalScope = [
      ['en', 'Your personal battles'],
      ['es', 'Tus batallas personales'],
      ['fr', 'Vos batailles personnelles'],
      ['it', 'Le tue battaglie personali'],
      ['uk', 'Ваші особисті битви'],
    ] as const;
    for (const [language, label] of expectedPersonalScope) {
      translations.use(language);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(label);
      expect(fixture.nativeElement.textContent).toContain(translations.t('battles.scope.selectHint'));
    }
    fixture.destroy();
  });
});
