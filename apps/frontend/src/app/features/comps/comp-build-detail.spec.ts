import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER, Subject } from 'rxjs';
import { expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { CompBuildDetailPage } from './comp-build-detail';

it('blocks rapid ability changes until the previous full-spells update finishes', async () => {
  const response = new Subject<unknown>();
  const put = vi.fn().mockReturnValue(response);
  await TestBed.configureTestingModule({
    imports: [CompBuildDetailPage],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: { put } },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ buildId: '1' }) }, paramMap: NEVER } },
      { provide: Router, useValue: {} },
      { provide: AlbionCatalogService, useValue: {} },
      { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      TranslateService,
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(CompBuildDetailPage);
  const page = fixture.componentInstance as unknown as {
    build: { set(value: unknown): void };
    saving: () => boolean;
    onAbilityChange: (loadout: 'main', slot: 'weapon', change: { kind: 'active'; index: number; spellId: string }) => Promise<void>;
  };
  const build = { id: 1, items: [{ slot: 'weapon', loadout: 'main', spells: { active: {}, passive: {} } }] };
  page.build.set(build);
  const first = page.onAbilityChange('main', 'weapon', { kind: 'active', index: 1, spellId: 'ONE' });
  expect(page.saving()).toBe(true);
  await page.onAbilityChange('main', 'weapon', { kind: 'active', index: 2, spellId: 'TWO' });
  expect(put).toHaveBeenCalledTimes(1);
  response.next({ ...build, items: [{ ...build.items[0], spells: { active: { 1: 'ONE' }, passive: {} } }] });
  response.complete();
  await first;
  expect(page.saving()).toBe(false);
  const nextResponse = new Subject<unknown>();
  put.mockReturnValue(nextResponse);
  const second = page.onAbilityChange('main', 'weapon', { kind: 'active', index: 2, spellId: 'TWO' });
  expect(put).toHaveBeenLastCalledWith('api/comps/builds/1/items/weapon/spells?loadout=main', {
    active: { 1: 'ONE', 2: 'TWO' }, passive: {},
  });
  nextResponse.next(build);
  nextResponse.complete();
  await second;
});

it('saves a slot and its abilities in one request', async () => {
  const response = new Subject<unknown>();
  const put = vi.fn().mockReturnValue(response);
  await TestBed.configureTestingModule({
    imports: [CompBuildDetailPage],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: { put } },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ buildId: '1' }) }, paramMap: NEVER } },
      { provide: Router, useValue: {} },
      { provide: AlbionCatalogService, useValue: {} },
      { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      TranslateService,
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(CompBuildDetailPage);
  const page = fixture.componentInstance as unknown as {
    build: { set(value: unknown): void };
    draftItemId: { set(value: string): void };
    draftItemType: { set(value: string): void };
    draftSpells: { set(value: unknown): void };
    saveSlot: (loadout: 'main', slot: 'weapon') => Promise<void>;
  };
  page.build.set({ id: 1, items: [] });
  page.draftItemId.set('42');
  page.draftItemType.set('weapon');
  page.draftSpells.set({ active: { 1: 'HEROICSTRIKE2' }, passive: {} });

  const saving = page.saveSlot('main', 'weapon');
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith(
    'api/comps/builds/1/items/weapon?loadout=main',
    expect.objectContaining({
      openalbion_item_id: 42,
      spells: { active: { 1: 'HEROICSTRIKE2' }, passive: {} },
    }),
  );
  response.next({ id: 1, items: [] });
  response.complete();
  await saving;
});
