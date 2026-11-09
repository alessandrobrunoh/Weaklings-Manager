import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlbionLinkRequestView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionLinkRequests } from './albion-link-requests';

function request(overrides: Partial<AlbionLinkRequestView> = {}): AlbionLinkRequestView {
  return {
    id: 1,
    discord_id: '111',
    user_id: 5,
    username: 'nelly',
    albion_player_id: 'p1',
    albion_player_name: 'Kay',
    albion_guild_name: 'Weaklings',
    requested_at: '2026-11-09T10:00:00+00:00',
    competing_requests: 0,
    character_already_linked: false,
    ...overrides,
  };
}

describe('AlbionLinkRequests', () => {
  let fixture: ComponentFixture<AlbionLinkRequests>;
  let queue: AlbionLinkRequestView[];
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let canReview: boolean;
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  async function create(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(AlbionLinkRequests);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(async () => {
    queue = [request()];
    canReview = true;
    get = vi.fn().mockImplementation(() => of(queue));
    post = vi.fn().mockImplementation(() => {
      queue = [];
      return of({});
    });
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AlbionLinkRequests],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get, post } },
        { provide: AuthService, useValue: { hasPermission: () => canReview } },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
  });

  afterEach(() => fixture?.destroy());

  it('lists the open requests for someone who can review them', async () => {
    const element = await create();
    expect(get).toHaveBeenCalledWith('api/albion/link/requests');
    expect(element.textContent).toContain('nelly');
    expect(element.textContent).toContain('Kay');
  });

  it('renders nothing and never calls the API without roles.manage', async () => {
    canReview = false;
    const element = await create();
    expect(get).not.toHaveBeenCalled();
    expect(element.querySelector('section')).toBeNull();
  });

  it('renders nothing while the queue is empty', async () => {
    queue = [];
    const element = await create();
    expect(element.querySelector('section')).toBeNull();
  });

  it('approves through the endpoint, confirms, and reloads the queue', async () => {
    const element = await create();
    const approve = element.querySelector<HTMLButtonElement>('button.btn--primary');
    approve?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(post).toHaveBeenCalledWith('api/albion/link/requests/1/approve', {});
    expect(toasts.success).toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(element.querySelector('section')).toBeNull();
  });

  it('rejects through the endpoint', async () => {
    const element = await create();
    element.querySelector<HTMLButtonElement>('button.btn--outline')?.click();
    await fixture.whenStable();

    expect(post).toHaveBeenCalledWith('api/albion/link/requests/1/reject', {});
  });

  it('will not approve a character that is already linked to another account', async () => {
    queue = [request({ character_already_linked: true })];
    const element = await create();
    const approve = element.querySelector<HTMLButtonElement>('button.btn--primary');
    expect(approve?.disabled).toBe(true);
    expect(element.textContent).toContain('albion.requests.alreadyLinked');
  });

  it('flags competing claims on the same character', async () => {
    queue = [request({ competing_requests: 2 })];
    const element = await create();
    expect(element.textContent).toContain('albion.requests.competing');
  });
});
