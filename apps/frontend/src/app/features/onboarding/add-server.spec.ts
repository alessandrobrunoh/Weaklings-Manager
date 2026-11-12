import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { AddServer } from './add-server';

describe('AddServer', () => {
  let fixture: ComponentFixture<AddServer>;
  let authMock: {
    registerableGuilds: ReturnType<typeof vi.fn>;
    botInvite: ReturnType<typeof vi.fn>;
  };

  async function createPage(): Promise<void> {
    fixture = TestBed.createComponent(AddServer);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    authMock = {
      registerableGuilds: vi.fn(async () => [{ id: 'g1', name: 'Midnight Crew', icon_hash: null }]),
      botInvite: vi.fn(async () => ({ url: 'https://discord.com/invite', client_id: '42' })),
    };

    await TestBed.configureTestingModule({
      imports: [AddServer],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AuthService, useValue: authMock },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    await createPage();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function dots(): HTMLButtonElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.step-dot'),
    );
  }

  function nextButton(): HTMLButtonElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.step-nav .btn--primary:not(a)',
    );
  }

  it('shows five numbered steps with progress and only the current step open', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(dots()).toHaveLength(5);
    expect(dots()[0].getAttribute('aria-current')).toBe('step');
    expect(compiled.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
    expect(compiled.querySelector('#add-server-step-title')?.textContent).toContain('addServer.step1.title');
    expect(compiled.querySelector('.guild-row')).toBeNull();
  });

  it('links the bot invite on step 1 with noopener', () => {
    const invite = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
      'a[href="https://discord.com/invite"]',
    );
    expect(invite).not.toBeNull();
    expect(invite?.rel).toContain('noopener');
  });

  it('moves through the steps with next, back and the numbered dots', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    nextButton()?.click();
    fixture.detectChanges();
    expect(compiled.querySelector('#add-server-step-title')?.textContent).toContain('addServer.step2.title');
    expect(dots()[0].classList).toContain('step-dot--done');
    expect(compiled.querySelector('.guild-row')?.textContent).toContain('Midnight Crew');

    dots()[4].click();
    fixture.detectChanges();
    expect(compiled.querySelector('#add-server-step-title')?.textContent).toContain('addServer.step5.title');
    expect(compiled.querySelector('.step-nav a')?.textContent).toContain('addServer.finish');
  });

  it('sends a registerable guild into the onboarding wizard', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    dots()[1].click();
    fixture.detectChanges();

    const row = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.guild-row');
    row?.click();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith(['/register-tenant'], {
      queryParams: { guild: 'g1', name: 'Midnight Crew' },
    });
  });

  it('shows a guild load failure as an error with retry, not as an empty list', async () => {
    fixture.destroy();
    authMock.registerableGuilds.mockClear();
    authMock.registerableGuilds.mockRejectedValueOnce(new Error('boom'));
    await createPage();
    dots()[1].click();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-error-state')?.textContent).toContain('addServer.guildsError');
    expect(compiled.querySelector('app-empty-state')).toBeNull();

    compiled.querySelector<HTMLButtonElement>('app-error-state button')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(authMock.registerableGuilds).toHaveBeenCalledTimes(2);
    expect(compiled.querySelector('.guild-row')?.textContent).toContain('Midnight Crew');
  });
});
