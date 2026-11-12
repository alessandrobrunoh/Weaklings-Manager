import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Battles } from './battles';

function render(queryParams: Record<string, string>) {
  TestBed.resetTestingModule();
  const queryParamMap = convertToParamMap(queryParams);
  TestBed.configureTestingModule({
    imports: [Battles],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap }, queryParamMap: of(queryParamMap) },
      },
      { provide: ApiService, useValue: { get: () => of({ items: [], total_items: 0 }) } },
      { provide: ToastService, useValue: { error: () => undefined } },
      TranslateService,
    ],
  });
  TestBed.inject(TranslateService).use('en');
  const fixture = TestBed.createComponent(Battles);
  fixture.detectChanges();
  return fixture;
}

async function settle(fixture: { detectChanges: () => void }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

describe('Battles list', () => {
  it('shows the guild scope by default with the summary band, filter bar and trends link', async () => {
    const fixture = render({});
    await settle(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Grouped guild fights');
    expect(text).toContain('canonical guild fight');
    expect(fixture.nativeElement.querySelector('app-summary-band')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-filter-bar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('a[href="/fights/trends"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.kpi-card')).toBeNull();
    fixture.destroy();
  });

  it('shows the personal scope when the tab is set in the URL', async () => {
    const fixture = render({ tab: 'me' });
    await settle(fixture);

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
