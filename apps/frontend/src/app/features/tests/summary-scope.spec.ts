import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Audit } from '../audit/audit';
import { Warns } from '../warns/warns';

describe('paginated summaries', () => {
  function setup(items: unknown[]) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: { get: vi.fn(() => of({ items, total_items: 100 })) } },
        { provide: AuthService, useValue: { hasPermission: () => true } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    });
  }

  it('scopes warning counts to the register page and hides them on escalations', async () => {
    setup([{ id: 1, user_id: 7, username: 'Kay', severity: 'strike', created_at: '2025-01-01' }]);
    const fixture = TestBed.createComponent(Warns);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent?.match(/common.currentPage/g)).toHaveLength(1);
    expect(element.querySelector('a[href="/users/7"]')).not.toBeNull();
    expect(element.textContent).not.toContain('warns.stat.escalations');
    (fixture.componentInstance as unknown as { switchTab: (tab: string) => void }).switchTab('escalations');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('warns.stat.active');
    fixture.destroy();
  });

  it('scopes audit counts and links the actor to their profile', async () => {
    setup([{ id: 1, user_id: 7, action: 'TEST', created_at: '2025-01-01' }]);
    const fixture = TestBed.createComponent(Audit);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    // The audit log no longer shows page-scoped counters at all.
    expect(element.textContent).not.toContain('audit.stat.');
    expect(element.querySelector('a[href="/users/7"]')).not.toBeNull();
    fixture.destroy();
  });
});
