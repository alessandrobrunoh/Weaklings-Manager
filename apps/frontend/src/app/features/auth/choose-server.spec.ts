import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { ChooseServer } from './choose-server';

describe('ChooseServer', () => {
  let fixture: ComponentFixture<ChooseServer>;
  let pendingTenants: ReturnType<typeof vi.fn>;
  let selectTenant: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [ChooseServer],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: AuthService,
          useValue: { pendingTenants, selectTenant, login: vi.fn() },
        },
        { provide: Router, useValue: { navigateByUrl } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ChooseServer);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function rows(): HTMLButtonElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.auth-list .auth-row')];
  }

  beforeEach(() => {
    pendingTenants = vi.fn(async () => [
      { id: 't1', name: 'Alpha Guild' },
      { id: 't2', name: 'Beta Guild' },
    ]);
    selectTenant = vi.fn(async () => ({}));
    navigateByUrl = vi.fn(async () => true);
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('lists each pending server as one row', async () => {
    await setup();
    expect(rows().map((row) => row.textContent?.trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('Alpha Guild'), expect.stringContaining('Beta Guild')]),
    );
    expect(rows().length).toBe(2);
  });

  it('enters the chosen server and goes to the dashboard', async () => {
    await setup();
    rows()[1].click();
    await fixture.whenStable();

    expect(selectTenant).toHaveBeenCalledWith('t2');
    expect(navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });

  it('offers sign-in again when there are no servers', async () => {
    pendingTenants = vi.fn(async () => []);
    await setup();

    expect(rows().length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).querySelector('app-empty-state')).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.btn--primary')).not.toBeNull();
  });
});
