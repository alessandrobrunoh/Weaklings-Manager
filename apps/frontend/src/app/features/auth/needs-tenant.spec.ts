import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { NeedsTenant } from './needs-tenant';

describe('NeedsTenant', () => {
  let fixture: ComponentFixture<NeedsTenant>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NeedsTenant],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            profile: () => ({ is_platform_admin: false }),
            registerableGuilds: async () => [{ id: 'g1', name: 'My Guild', icon_hash: null }],
          },
        },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(NeedsTenant);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('explains that the guild panel is closed until registration', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('auth.needs_tenant_title');
    expect(compiled.textContent).toContain('auth.needs_tenant_body');
    expect(compiled.textContent).toContain('My Guild');
    expect(compiled.textContent).not.toContain('nav.platform');
  });
});
