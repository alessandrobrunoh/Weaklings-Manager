import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildItemSlot } from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { CompBuildDetailPage } from './comp-build-detail';

interface PageInternals {
  build: { (): unknown; set(value: unknown): void };
  editing: { (): boolean; set(value: boolean): void };
  dirty: { (): number; set(value: number): void };
  pendingDiscard: () => boolean;
  saving: () => boolean;
  loadFailed: () => boolean;
  notFound: () => boolean;
  saveLoadout: (changes: unknown[]) => Promise<void>;
  requestDiscard: () => void;
  confirmDiscard: () => void;
  keepEditing: () => void;
  onBeforeUnload: (event: BeforeUnloadEvent) => void;
  load: (id: number, silent?: boolean) => Promise<void>;
}

const BOW: BuildItemSlot = {
  loadout: 'main',
  slot: 'weapon',
  openalbion_item_type: 'weapon',
  openalbion_item_id: 42,
  openalbion_item_name: 'Bow',
  openalbion_item_icon: 'https://render.albiononline.com/v1/item/T8_2H_BOW.png',
  openalbion_item_tier: 'T8',
  openalbion_item_quality: 4,
  openalbion_item_enchantment: 0,
  spells: { active: { '1': 'SPREAD' }, passive: {} },
};

const BUILD = { id: 1, role: 'dps', weapon_key: '2H_BOW', items: [BOW] };

function setup(api: Record<string, unknown>) {
  const toasts = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    imports: [CompBuildDetailPage],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) } },
      { provide: ToastService, useValue: toasts },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ buildId: '1' }) }, paramMap: NEVER },
      },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve([]) } },
      { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      TranslateService,
    ],
  });
  const fixture = TestBed.createComponent(CompBuildDetailPage);
  const page = fixture.componentInstance as unknown as PageInternals;
  return { fixture, page, toasts };
}

describe('CompBuildDetailPage loadout saving', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('saves each changed slot with its abilities in the same request', async () => {
    const put = vi.fn().mockReturnValue(of(BUILD));
    const get = vi.fn().mockReturnValue(of(BUILD));
    const { page, toasts } = setup({ put, get, delete: vi.fn() });
    page.build.set(BUILD);

    await page.saveLoadout([{ loadout: 'main', slot: 'weapon', item: { ...BOW, openalbion_item_id: 43 } }]);

    expect(put).toHaveBeenCalledWith(
      'api/comps/builds/1/items/weapon?loadout=main',
      expect.objectContaining({
        openalbion_item_id: 43,
        openalbion_item_tier: 'T8',
        spells: { active: { '1': 'SPREAD' }, passive: {} },
      }),
    );
    expect(toasts.success).toHaveBeenCalledTimes(1);
  });

  it('sends an empty spell selection rather than omitting it, so removed abilities are cleared', async () => {
    const put = vi.fn().mockReturnValue(of(BUILD));
    const { page } = setup({ put, get: vi.fn().mockReturnValue(of(BUILD)), delete: vi.fn() });
    page.build.set(BUILD);

    await page.saveLoadout([
      { loadout: 'main', slot: 'weapon', item: { ...BOW, spells: undefined } },
    ]);

    expect(put.mock.calls[0][1].spells).toEqual({ active: {}, passive: {} });
  });

  it('clears a slot with DELETE and reloads the build instead of nulling it on 204', async () => {
    const del = vi.fn().mockReturnValue(of(undefined));
    const reloaded = { ...BUILD, items: [BOW] };
    const get = vi.fn().mockReturnValue(of(reloaded));
    const { page } = setup({ put: vi.fn(), delete: del, get });
    page.build.set({ ...BUILD, items: [BOW, { ...BOW, slot: 'head' }] });
    page.editing.set(true);

    await page.saveLoadout([{ loadout: 'main', slot: 'head', item: null }]);

    expect(del).toHaveBeenCalledWith('api/comps/builds/1/items/head?loadout=main');
    expect(get).toHaveBeenCalledWith('api/comps/builds/1');
    expect(page.build()).toEqual(reloaded);
    expect(page.editing()).toBe(false);
  });

  it('applies the changes in order and keeps the editor open when one fails', async () => {
    const put = vi.fn().mockReturnValueOnce(of(BUILD)).mockReturnValueOnce(throwError(() => new Error('boom')));
    const get = vi.fn().mockReturnValue(of(BUILD));
    const { page, toasts } = setup({ put, get, delete: vi.fn() });
    page.build.set(BUILD);
    page.editing.set(true);

    await page.saveLoadout([
      { loadout: 'main', slot: 'weapon', item: BOW },
      { loadout: 'main', slot: 'head', item: { ...BOW, slot: 'head' } },
      { loadout: 'main', slot: 'armor', item: { ...BOW, slot: 'armor' } },
    ]);

    expect(put).toHaveBeenCalledTimes(2);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(page.editing()).toBe(true);
    expect(page.saving()).toBe(false);
  });

  it('refuses to send anything when the change would leave a non-mount build without a weapon', async () => {
    const put = vi.fn();
    const del = vi.fn();
    const { page, toasts } = setup({ put, delete: del, get: vi.fn() });
    page.build.set(BUILD);

    await page.saveLoadout([{ loadout: 'main', slot: 'weapon', item: null }]);

    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty change list', async () => {
    const put = vi.fn();
    const { page } = setup({ put, delete: vi.fn(), get: vi.fn() });
    page.build.set(BUILD);

    await page.saveLoadout([]);

    expect(put).not.toHaveBeenCalled();
  });
});

describe('CompBuildDetailPage unsaved changes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('leaves edit mode at once on Discard when nothing changed', () => {
    const { page } = setup({});
    page.build.set(BUILD);
    page.editing.set(true);

    page.requestDiscard();

    expect(page.editing()).toBe(false);
    expect(page.pendingDiscard()).toBe(false);
  });

  it('asks before throwing away unsaved changes, and keeps them on Keep editing', () => {
    const { page } = setup({});
    page.build.set(BUILD);
    page.editing.set(true);
    page.dirty.set(2);

    page.requestDiscard();
    expect(page.pendingDiscard()).toBe(true);
    expect(page.editing()).toBe(true);

    page.keepEditing();
    expect(page.pendingDiscard()).toBe(false);
    expect(page.editing()).toBe(true);
    expect(page.dirty()).toBe(2);
  });

  it('drops the draft once the discard is confirmed', () => {
    const { page } = setup({});
    page.build.set(BUILD);
    page.editing.set(true);
    page.dirty.set(2);

    page.requestDiscard();
    page.confirmDiscard();

    expect(page.editing()).toBe(false);
    expect(page.dirty()).toBe(0);
    expect(page.pendingDiscard()).toBe(false);
  });

  it('asks the browser to confirm closing the tab only while changes are unsaved', () => {
    const { page } = setup({});
    page.build.set(BUILD);
    const event = () => ({ preventDefault: vi.fn() }) as unknown as BeforeUnloadEvent;

    const idle = event();
    page.onBeforeUnload(idle);
    expect(idle.preventDefault).not.toHaveBeenCalled();

    page.editing.set(true);
    page.dirty.set(1);
    const unsaved = event();
    page.onBeforeUnload(unsaved);
    expect(unsaved.preventDefault).toHaveBeenCalled();
  });
});

describe('CompBuildDetailPage loading', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('tells a missing build apart from a failed request', async () => {
    const missing = setup({
      get: vi.fn().mockReturnValue(throwError(() => new ApiError(404, 'not found'))),
    });
    await missing.page.load(1);
    expect(missing.page.notFound()).toBe(true);
    expect(missing.page.loadFailed()).toBe(false);

    TestBed.resetTestingModule();
    const failed = setup({
      get: vi.fn().mockReturnValue(throwError(() => new ApiError(500, 'server'))),
    });
    await failed.page.load(1);
    expect(failed.page.notFound()).toBe(false);
    expect(failed.page.loadFailed()).toBe(true);
  });
});
