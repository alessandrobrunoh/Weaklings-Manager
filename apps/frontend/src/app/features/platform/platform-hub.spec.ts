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

  it('renders workspace cards and counts', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('nav.platform.tenants');
    expect(compiled.textContent).toContain('nav.platform.admins');
    expect(compiled.textContent).toContain('2');
    expect(compiled.textContent).toContain('1');
    expect(compiled.querySelector('a[href="/platform/tenants"]')).toBeTruthy();
    expect(compiled.querySelector('a[href="/platform/admins"]')).toBeTruthy();
    expect(compiled.querySelector('a[href="/platform/ranks"]')).toBeTruthy();
  });
});
