import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { Sidebar } from './sidebar';

describe('Sidebar', () => {
  let fixture: ComponentFixture<Sidebar>;
  const profile = signal<Record<string, unknown> | null>({
    tenant_id: '222',
    tenant_name: 'Nova Legion',
    is_platform_admin: false,
    features: ['events'],
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Sidebar],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { profile, hasPermission: () => true },
        },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Sidebar);
    fixture.componentRef.setInput('sections', [
      {
        headingKey: 'nav.section.operations',
        items: [{ path: '/events', icon: 'calendar', labelKey: 'nav.events', featureKey: 'events' }],
      },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  /** The header used to be the hardcoded product wordmark on every server. */
  it('heads the column with the open server, not the product name', async () => {
    const header = (fixture.nativeElement as HTMLElement).querySelector('.server-header__name');
    expect(header?.textContent?.trim()).toBe('Nova Legion');

    profile.set({ tenant_id: '111', tenant_name: 'Weaklings', is_platform_admin: false, features: ['events'] });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.server-header__name')?.textContent?.trim(),
    ).toBe('Weaklings');
  });

  it('folds a category away when its heading is clicked', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const group = compiled.querySelector<HTMLUListElement>('#group-nav\\.section\\.operations');
    expect(group?.hidden).toBe(false);

    compiled.querySelector<HTMLButtonElement>('.category')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      compiled.querySelector<HTMLUListElement>('#group-nav\\.section\\.operations')?.hidden,
    ).toBe(true);
  });
});
