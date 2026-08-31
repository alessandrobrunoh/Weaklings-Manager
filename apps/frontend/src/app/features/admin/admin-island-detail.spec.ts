import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SplitIsland } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminIslandDetail } from './admin-island-detail';

const mockIsland: SplitIsland = {
  id: 42,
  name: 'Guild Island Prime',
  city: 'lymhurst',
  tabs: [
    { id: 101, name: 'Loot Chest 1', sort_order: 0 },
    { id: 102, name: 'Silver Stash', sort_order: 1 },
  ],
};

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

describe('AdminIslandDetail', () => {
  let fixture: ComponentFixture<AdminIslandDetail>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let toasts: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let router: Router;

  beforeEach(async () => {
    stubDialogApi();

    api = {
      get: vi.fn().mockReturnValue(of([mockIsland])),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    toasts = {
      success: vi.fn(),
      error: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [AdminIslandDetail],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        {
          provide: TranslateService,
          useValue: {
            t: (key: string) => key,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ islandId: '42' })),
            snapshot: {
              paramMap: convertToParamMap({ islandId: '42' }),
            },
          },
        },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(AdminIslandDetail);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads and displays the island details', () => {
    expect(api.get).toHaveBeenCalledWith('api/splits/islands');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Guild Island Prime');
    expect(compiled.textContent).toContain('Loot Chest 1');
    expect(compiled.textContent).toContain('Silver Stash');
  });

  it('saves island name and city changes via PATCH', async () => {
    const updatedIsland: SplitIsland = {
      ...mockIsland,
      name: 'Renamed Island',
      city: 'caerleon',
    };
    api.patch.mockReturnValue(of(updatedIsland));

    const nameInput = fixture.nativeElement.querySelector('input[type="text"]') as HTMLInputElement;
    nameInput.value = 'Renamed Island';
    nameInput.dispatchEvent(new Event('input'));

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'caerleon';
    select.dispatchEvent(new Event('change'));

    fixture.detectChanges();
    await fixture.whenStable();

    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    await fixture.componentInstance['onSaveIsland'](new SubmitEvent('submit'));

    expect(api.patch).toHaveBeenCalledWith('api/splits/islands/42', {
      name: 'Renamed Island',
      city: 'caerleon',
    });
    expect(toasts.success).toHaveBeenCalledWith('admin.islands.updated');
  });

  it('adds a new tab via POST', async () => {
    const updatedWithTab: SplitIsland = {
      ...mockIsland,
      tabs: [
        ...mockIsland.tabs,
        { id: 103, name: 'New Gear Chest', sort_order: 2 },
      ],
    };
    api.post.mockReturnValue(of(updatedWithTab));

    fixture.componentInstance['openAddTab']();
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance['newTabName'].set('New Gear Chest');
    await fixture.componentInstance['onAddTabSubmit'](new SubmitEvent('submit'));

    expect(api.post).toHaveBeenCalledWith('api/splits/islands/42/tabs', {
      name: 'New Gear Chest',
    });
    expect(toasts.success).toHaveBeenCalledWith('admin.islands.tabAdded');
  });

  it('reorders tabs via PATCH', async () => {
    api.patch.mockReturnValue(of({}));

    // Move first tab down (index 0, direction +1)
    await fixture.componentInstance['moveTab'](0, 1);

    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(api.patch).toHaveBeenCalledWith('api/splits/islands/42/tabs/101', {
      sort_order: 1,
    });
    expect(api.patch).toHaveBeenCalledWith('api/splits/islands/42/tabs/102', {
      sort_order: 0,
    });
  });

  it('deletes a tab via DELETE', async () => {
    const remainingTabsIsland: SplitIsland = {
      ...mockIsland,
      tabs: [{ id: 101, name: 'Loot Chest 1', sort_order: 0 }],
    };
    api.delete.mockReturnValue(of(remainingTabsIsland));

    fixture.componentInstance['askDeleteTab'](mockIsland.tabs[1]);
    await fixture.componentInstance['confirmDeleteTab']();

    expect(api.delete).toHaveBeenCalledWith('api/splits/islands/42/tabs/102');
    expect(toasts.success).toHaveBeenCalledWith('admin.islands.detail.tabDeleted');
  });

  it('deletes the island and navigates back to /admin/islands', async () => {
    api.delete.mockReturnValue(of(undefined));

    fixture.componentInstance['deleteIslandOpen'].set(true);
    await fixture.componentInstance['confirmDeleteIsland']();

    expect(api.delete).toHaveBeenCalledWith('api/splits/islands/42');
    expect(toasts.success).toHaveBeenCalledWith('admin.islands.deleted');
    expect(router.navigate).toHaveBeenCalledWith(['/admin/islands']);
  });
});
