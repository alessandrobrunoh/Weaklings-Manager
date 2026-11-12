import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformHub } from './platform-hub';

describe('PlatformHub', () => {
  let fixture: ComponentFixture<PlatformHub>;
  let api: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      get: vi.fn((path: string) => {
        if (path === 'api/platform/tenants') {
          return of([{ id: '1' }, { id: '2' }]);
        }
        if (path === 'api/platform/admins') {
          return of([{ discord_id: '9' }]);
        }
        return of([]);
      }),
    };

    await TestBed.configureTestingModule({
      imports: [PlatformHub],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlatformHub);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('shows the platform counts in the summary band', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const band = compiled.querySelector('[role="group"]');
    expect(band?.getAttribute('aria-label')).toBe('platform.hub.summary');
    const stats = Array.from(compiled.querySelectorAll('app-stat')).map((stat) => stat.textContent);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toContain('nav.platform.tenants');
    expect(stats[0]).toContain('2');
    expect(stats[1]).toContain('nav.platform.admins');
    expect(stats[1]).toContain('1');
  });

  it('groups the entries under Tenants, Access and Configuration', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const headings = Array.from(compiled.querySelectorAll('section h2')).map((h) => h.textContent?.trim());
    expect(headings).toEqual([
      'platform.hub.groupTenants',
      'platform.hub.groupAccess',
      'platform.hub.groupConfig',
    ]);
    expect(compiled.querySelectorAll('section ul > li')).toHaveLength(4);
  });

  it('links each entry to its existing route, with a description', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('a[href="/platform/tenants"]')).toBeTruthy();
    expect(compiled.querySelector('a[href="/platform/admins"]')).toBeTruthy();
    expect(compiled.querySelector('a[href="/platform/ranks"]')).toBeTruthy();
    // Feature flags are per tenant, so their entry opens the tenant list.
    const tenantLinks = compiled.querySelectorAll('a[href="/platform/tenants"]');
    expect(tenantLinks).toHaveLength(2);
    expect(compiled.querySelector('a[href="/platform/ranks"]')?.textContent).toContain(
      'platform.hub.ranksHint',
    );
  });
});
