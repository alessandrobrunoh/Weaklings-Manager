import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { NeedsTenant } from './needs-tenant';

describe('NeedsTenant', () => {
  let fixture: ComponentFixture<NeedsTenant>;
  let registerableGuilds: ReturnType<typeof vi.fn>;

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [NeedsTenant],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            profile: () => ({ is_platform_admin: false }),
            registerableGuilds,
            botInvite: async () => ({ url: 'https://discord.com/invite', client_id: '1' }),
          },
        },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(NeedsTenant);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    registerableGuilds = vi.fn(async () => [{ id: 'g1', name: 'My Guild', icon_hash: null }]);
  });

  afterEach(() => {
    fixture?.destroy();
  });

  describe('with registerable guilds', () => {
    beforeEach(async () => {
      await setup();
    });

    it('explains that the guild panel is closed until registration', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.querySelector('h1')?.textContent).toContain('auth.needs_tenant_title');
      expect(compiled.textContent).toContain('auth.needs_tenant_body');
      expect(compiled.textContent).toContain('My Guild');
      expect(compiled.textContent).not.toContain('nav.platform');
    });

    it('lists each registerable guild as one row', () => {
      const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.auth-list .auth-row');
      expect(rows.length).toBe(1);
    });

    it('offers the bot invite as a secondary action while guilds are listed', () => {
      const invite = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
        'a[href="https://discord.com/invite"]',
      );
      expect(invite).not.toBeNull();
      expect(invite?.target).toBe('_blank');
      expect(invite?.classList).toContain('btn--outline');
    });
  });

  describe('with no registerable guilds', () => {
    beforeEach(async () => {
      registerableGuilds = vi.fn(async () => []);
      await setup();
    });

    it('says why the list is empty and makes the invite the primary action', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.textContent).toContain('auth.needs_tenant_empty');
      const invite = compiled.querySelector<HTMLAnchorElement>('a[href="https://discord.com/invite"]');
      expect(invite?.classList).toContain('btn--primary');
    });
  });

  describe('when the guild list fails to load', () => {
    beforeEach(async () => {
      registerableGuilds = vi.fn(async () => {
        throw new Error('network down');
      });
      await setup();
    });

    it('shows an error with a retry, not the empty copy', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.querySelector('app-error-state')).not.toBeNull();
      expect(compiled.textContent).not.toContain('auth.needs_tenant_empty');
    });

    it('retries the load when the retry is pressed', async () => {
      registerableGuilds.mockResolvedValueOnce([{ id: 'g1', name: 'My Guild', icon_hash: null }]);
      const retry = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        'app-error-state button',
      );
      retry?.click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(registerableGuilds).toHaveBeenCalledTimes(2);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('My Guild');
    });
  });
});
