import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { TenantRail } from './tenant-rail';

describe('TenantRail', () => {
  let fixture: ComponentFixture<TenantRail>;
  let auth: {
    myTenants: ReturnType<typeof vi.fn>;
    switchTenant: ReturnType<typeof vi.fn>;
    profile: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    auth = {
      myTenants: vi.fn().mockResolvedValue([
        { id: '111', name: 'Weaklings', slug: 'w', icon_hash: null },
        { id: '222', name: 'Alts', slug: 'a', icon_hash: null },
      ]),
      switchTenant: vi.fn().mockResolvedValue({}),
      profile: vi.fn().mockReturnValue({ tenant_id: '111' }),
    };

    await TestBed.configureTestingModule({
      imports: [TenantRail],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AuthService, useValue: auth },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TenantRail);
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders a button per tenant and switches on click', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('W');
    expect(compiled.textContent).toContain('A');
    const buttons = compiled.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    (buttons[1] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(auth.switchTenant).toHaveBeenCalledWith('222');
  });

  it('pins the add-a-server orb under the tenants', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const add = compiled.querySelector<HTMLAnchorElement>('a.rail__orb--add');
    expect(add).not.toBeNull();
    expect(add?.getAttribute('href')).toBe('/add-server');
  });
});
