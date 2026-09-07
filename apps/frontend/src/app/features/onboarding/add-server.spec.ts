import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { AddServer } from './add-server';

describe('AddServer', () => {
  let fixture: ComponentFixture<AddServer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddServer],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            registerableGuilds: async () => [{ id: 'g1', name: 'Midnight Crew', icon_hash: null }],
            botInvite: async () => ({ url: 'https://discord.com/invite', client_id: '42' }),
          },
        },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AddServer);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('walks the five setup steps and links the bot invite', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    for (const step of [1, 2, 3, 4, 5]) {
      expect(compiled.textContent).toContain(`addServer.step${step}.title`);
    }
    const invites = compiled.querySelectorAll<HTMLAnchorElement>(
      'a[href="https://discord.com/invite"]',
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].rel).toContain('noopener');
  });

  it('sends a registerable guild into the onboarding wizard', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Midnight Crew');

    const row = compiled.querySelector<HTMLButtonElement>('.guild-row');
    row?.click();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith(['/register-tenant'], {
      queryParams: { guild: 'g1', name: 'Midnight Crew' },
    });
  });
});
