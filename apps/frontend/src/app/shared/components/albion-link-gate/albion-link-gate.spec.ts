import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlbionLinkStatus } from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import { AlbionLinkGate } from './albion-link-gate';

const NONE: AlbionLinkStatus = { linked: false };
const LINKED: AlbionLinkStatus = {
  linked: true,
  albion_player_id: 'p1',
  albion_player_name: 'Kay',
};

describe('AlbionLinkGate', () => {
  let fixture: ComponentFixture<AlbionLinkGate>;
  let status: AlbionLinkStatus;
  let get: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
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
    post = vi.fn().mockImplementation(() => of(LINKED));
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AlbionLinkGate],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get, post } },
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

  it('shows nothing once the member is linked', async () => {
    status = LINKED;
    const element = await create();
    expect(element.querySelector('[role="dialog"]')).toBeNull();
  });

  it('links at once when a character is picked and drops the gate', async () => {
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
    expect(emitted).toHaveBeenCalledWith(LINKED);
    expect(toasts.success).toHaveBeenCalledWith('albion.linked');
    expect(element.querySelector('[role="dialog"]')).toBeNull();
  });
});
