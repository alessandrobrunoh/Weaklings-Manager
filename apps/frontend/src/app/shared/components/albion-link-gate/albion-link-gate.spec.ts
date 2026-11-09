import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlbionLinkStatus } from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import { AlbionLinkGate } from './albion-link-gate';

const NONE: AlbionLinkStatus = { linked: false, pending: false };
const PENDING: AlbionLinkStatus = {
  linked: false,
  pending: true,
  pending_albion_player_id: 'p1',
  pending_albion_player_name: 'Kay',
};
const LINKED: AlbionLinkStatus = {
  linked: true,
  pending: false,
  albion_player_id: 'p1',
  albion_player_name: 'Kay',
};

describe('AlbionLinkGate', () => {
  let fixture: ComponentFixture<AlbionLinkGate>;
  let status: AlbionLinkStatus;
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  async function create(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(AlbionLinkGate);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(async () => {
    status = NONE;
    get = vi.fn().mockImplementation((path: string) =>
      path === 'api/albion/link/me'
        ? of(status)
        : of({ players: [{ id: 'p1', name: 'Kay', guild_name: 'Weaklings' }] }),
    );
    post = vi.fn().mockImplementation(() => of(PENDING));
    del = vi.fn().mockImplementation(() => of(null));
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AlbionLinkGate],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get, post, delete: del } },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
  });

  afterEach(() => fixture?.destroy());

  it('asks an unlinked member to search for a character', async () => {
    const element = await create();
    expect(element.textContent).toContain('albion.required.title');
    expect(element.querySelector('form')).not.toBeNull();
  });

  it('keeps blocking a member whose request is waiting, and says so', async () => {
    status = PENDING;
    const element = await create();
    expect(element.textContent).toContain('albion.pending.title');
    expect(element.querySelector('form')).toBeNull();
  });

  it('shows nothing once the member is linked', async () => {
    status = LINKED;
    const element = await create();
    expect(element.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not report a link when the answer is only a pending request', async () => {
    const element = await create();
    const emitted = vi.fn();
    fixture.componentInstance.linked.subscribe(emitted);

    const input = element.querySelector<HTMLInputElement>('input');
    input!.value = 'Kay';
    input!.dispatchEvent(new Event('input'));
    element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('button.surface')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(post).toHaveBeenCalledWith('api/albion/link', {
      albion_player_id: 'p1',
      albion_player_name: 'Kay',
    });
    expect(emitted).not.toHaveBeenCalled();
    expect(element.textContent).toContain('albion.pending.title');
    expect(toasts.success).toHaveBeenCalledWith('albion.pending.sent');
  });

  it('lets a waiting member withdraw and pick another character', async () => {
    status = PENDING;
    const element = await create();
    const withdraw = [...element.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('albion.pending.withdraw'),
    );
    withdraw?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(del).toHaveBeenCalledWith('api/albion/link');
    expect(element.querySelector('form')).not.toBeNull();
  });

  it('drops the gate and reports the link once an officer has approved', async () => {
    status = PENDING;
    const element = await create();
    const emitted = vi.fn();
    fixture.componentInstance.linked.subscribe(emitted);

    status = LINKED;
    const check = [...element.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('albion.pending.refresh'),
    );
    check?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(emitted).toHaveBeenCalledWith(LINKED);
    expect(element.querySelector('[role="dialog"]')).toBeNull();
  });
});
