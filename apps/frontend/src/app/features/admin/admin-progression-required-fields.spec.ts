import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminProgression } from './admin-progression';

const settings = {
  xp_base: 100,
  xp_exponent: 1.5,
  max_level: 50,
  xp_message: 1,
  xp_event_create: 25,
  xp_event_join: 10,
  xp_event_complete: 15,
  xp_vod: 40,
  message_cooldown_secs: 60,
  message_min_chars: 2,
  warn_threshold: 3,
  vod_forum_channel_id: null,
  message_channel_deny_list: [],
  level_preview: [],
  guild_ranks: [
    { name: 'Recruit', min_xp: 0, discord_role_id: null },
    { name: 'Active', min_xp: 400, discord_role_id: null },
    { name: 'Reliable', min_xp: 900, discord_role_id: null },
    { name: 'Veteran', min_xp: 1500, discord_role_id: null },
    { name: 'Core Member', min_xp: 2200, discord_role_id: null },
  ],
};

const seasons = [
  {
    id: 1,
    name: 'Current season',
    starts_at: '2026-01-01T00:00:00Z',
    ends_at: '2026-12-31T23:59:59Z',
    is_active: true,
  },
];

function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') return;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

async function render(api: unknown): Promise<ComponentFixture<AdminProgression>> {
  stubDialogApi();
  await TestBed.configureTestingModule({
    imports: [AdminProgression],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: api },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: TranslateService, useValue: { t: (key: string) => key } },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(AdminProgression);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('AdminProgression required fields', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks required progression values and season create and edit fields', async () => {
    const api = {
      get: vi.fn((url: string) =>
        of(
          url === 'api/progression/settings'
            ? settings
            : url === 'api/progression/seasons'
              ? seasons
              : [],
        ),
      ),
      put: vi.fn(() => of(settings)),
    };
    const fixture = await render(api);
    const compiled = fixture.nativeElement as HTMLElement;

    const forms = compiled.querySelectorAll('form');
    const settingsForm = forms[0] as HTMLFormElement;
    expect(settingsForm.textContent).toContain('validation.requiredLegend');
    const numericInputs = settingsForm.querySelectorAll<HTMLInputElement>('input[required]');
    expect(numericInputs).toHaveLength(11);
    expect(
      [...numericInputs].every((input) =>
        input.closest('label')?.querySelector('[aria-hidden="true"]'),
      ),
    ).toBe(true);

    const rankForm = forms[1] as HTMLFormElement;
    expect(rankForm.querySelectorAll('tbody tr')).toHaveLength(5);

    // The season table is the last one on the page; its edit button is the last match.
    const editButton = [...compiled.querySelectorAll('button')]
      .filter((button) => button.textContent?.includes('common.edit'))
      .at(-1);
    expect(editButton).toBeDefined();
    editButton?.click();
    fixture.detectChanges();

    const editForm = compiled.querySelector<HTMLFormElement>('#season-dialog-form');
    expect(editForm).not.toBeNull();
    expect(editForm?.textContent).toContain('validation.requiredLegend');
    expect(editForm?.querySelectorAll('input[required]')).toHaveLength(3);
    expect(editForm?.checkValidity()).toBe(true);

    buttonWithText(compiled, 'common.cancel')?.click();
    fixture.detectChanges();
    expect(compiled.querySelector('#season-dialog-form')).toBeNull();

    buttonWithText(compiled, 'admin.progression.createSeason')?.click();
    fixture.detectChanges();

    const createForm = compiled.querySelector<HTMLFormElement>('#season-dialog-form');
    expect(createForm?.textContent).toContain('validation.requiredLegend');
    expect(createForm?.querySelectorAll('input[required]')).toHaveLength(3);
    expect(createForm?.querySelectorAll('label [aria-hidden="true"]')).toHaveLength(3);
    expect(createForm?.checkValidity()).toBe(false);
  });

  it('lets admins add and remove tiers and submit the ordered configuration', async () => {
    const api = {
      get: vi.fn((url: string) =>
        of(url === 'api/progression/settings' ? settings : []),
      ),
      put: vi.fn(() => of(settings)),
    };
    const fixture = await render(api);
    const compiled = fixture.nativeElement as HTMLElement;
    const rankForm = [...compiled.querySelectorAll('form')][1] as HTMLFormElement;

    // Remove the second tier ("Active") from its edit dialog.
    const editButtons = [...rankForm.querySelectorAll('button')]
      .filter((button) => button.textContent?.includes('common.edit'));
    expect(editButtons).toHaveLength(5);
    editButtons[1]?.click();
    fixture.detectChanges();
    expect(compiled.querySelector('#rank-dialog-form')).not.toBeNull();

    buttonWithText(compiled, 'admin.progression.rankRemove')?.click();
    fixture.detectChanges();
    expect(compiled.querySelector('#rank-dialog-form')).toBeNull();
    expect(rankForm.querySelectorAll('tbody tr')).toHaveLength(4);

    // Add a new tier at the end; the dialog defaults to the next minimum XP.
    buttonWithText(rankForm, 'admin.progression.rankAdd')?.click();
    fixture.detectChanges();
    const addForm = compiled.querySelector<HTMLFormElement>('#rank-dialog-form');
    expect(addForm?.querySelectorAll('input[required]')).toHaveLength(2);
    expect(addForm?.checkValidity()).toBe(true);
    addForm?.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
    expect(compiled.querySelector('#rank-dialog-form')).toBeNull();
    expect(rankForm.querySelectorAll('tbody tr')).toHaveLength(5);

    const saveButton = rankForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    saveButton.click();
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith(
      'api/progression/settings',
      {
        guild_ranks: [
          settings.guild_ranks[0],
          settings.guild_ranks[2],
          settings.guild_ranks[3],
          settings.guild_ranks[4],
          { name: 'admin.progression.rankNewName', min_xp: 2201, discord_role_id: null },
        ],
      },
    );
  });
});
