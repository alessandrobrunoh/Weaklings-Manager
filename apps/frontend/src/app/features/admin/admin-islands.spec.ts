import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SplitIsland } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminIslands } from './admin-islands';

const guildIslands: SplitIsland[] = [
  {
    id: 1,
    name: 'Guild Island Prime',
    city: 'lymhurst',
    tabs: [{ id: 101, name: 'Loot', sort_order: 0 }],
  },
];

const allianceIslands: SplitIsland[] = [
  {
    id: 2,
    name: 'Bank Island',
    city: 'caerleon',
    tabs: [{ id: 201, name: 'Silver', sort_order: 0 }],
    source_guild_tenant_id: 'g-beta',
    source_guild_name: 'Beta',
  },
  {
    id: 1,
    name: 'Bank Island',
    city: 'lymhurst',
    tabs: [{ id: 101, name: 'Loot', sort_order: 0 }],
    source_guild_tenant_id: 'g-alpha',
    source_guild_name: 'Alpha',
  },
  {
    id: 3,
    name: 'Vault',
    city: 'martlock',
    tabs: [{ id: 301, name: 'Gear', sort_order: 0 }],
    source_guild_tenant_id: 'g-alpha',
    source_guild_name: 'Alpha',
  },
];

function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') {
    return;
  }
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    Object.defineProperty(this, 'open', { configurable: true, get: () => true });
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    Object.defineProperty(this, 'open', { configurable: true, get: () => false });
    this.dispatchEvent(new Event('close'));
  };
}

async function createComponent(
  islands: SplitIsland[],
  tenantKind: 'guild' | 'alliance',
): Promise<{
  fixture: ComponentFixture<AdminIslands>;
  api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
}> {
  stubDialogApi();
  const api = {
    get: vi.fn().mockReturnValue(of(islands)),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };

  await TestBed.configureTestingModule({
    imports: [AdminIslands],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: TranslateService, useValue: { t: (key: string) => key } },
      {
        provide: AuthService,
        useValue: { profile: () => ({ tenant_kind: tenantKind }) },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(AdminIslands);
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api };
}

describe('AdminIslands', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('keeps create, add-tab, edit, and delete available for a guild tenant', async () => {
    const { fixture, api } = await createComponent(guildIslands, 'guild');
    const compiled = fixture.nativeElement as HTMLElement;

    expect(api.get).toHaveBeenCalledWith('api/splits/islands');
    expect(compiled.textContent).toContain('Guild Island Prime');
    expect(compiled.textContent).toContain('admin.islands.create');
    expect(compiled.textContent).toContain('admin.islands.addTab');
    expect(compiled.textContent).toContain('common.edit');
    expect(compiled.textContent).toContain('common.delete');
    expect(compiled.querySelectorAll('h2').length).toBe(0);
  });

  it('groups alliance catalog rows by source guild and hides mutations', async () => {
    const { fixture, api } = await createComponent(allianceIslands, 'alliance');
    const compiled = fixture.nativeElement as HTMLElement;
    const headings = [...compiled.querySelectorAll('h2')].map((node) => node.textContent?.trim());

    expect(api.get).toHaveBeenCalledWith('api/splits/islands');
    expect(headings).toEqual(['Alpha', 'Beta']);
    expect(compiled.textContent).toContain('Bank Island');
    expect(compiled.textContent).toContain('Vault');
    expect(compiled.textContent).toContain('admin.islands.readonlyHint');
    expect(compiled.textContent).toContain('common.view');
    expect(compiled.textContent).not.toContain('admin.islands.create');
    expect(compiled.textContent).not.toContain('admin.islands.addTab');
    expect(compiled.textContent).not.toContain('common.edit');
    expect(compiled.textContent).not.toContain('common.delete');
  });

  it('does not post a new island when the tenant is an alliance', async () => {
    const { fixture, api } = await createComponent(allianceIslands, 'alliance');
    fixture.componentInstance['newIslandName'].set('Should not save');
    fixture.componentInstance['newIslandTabs'].set('Loot');
    await fixture.componentInstance['onCreateIsland'](new SubmitEvent('submit'));
    expect(api.post).not.toHaveBeenCalled();
  });
});
