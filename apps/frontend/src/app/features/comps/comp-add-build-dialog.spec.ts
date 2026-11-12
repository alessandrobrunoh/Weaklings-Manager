import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildSummary } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { TranslateService } from '../../core/services/translate.service';
import { CompAddBuildDialog, type CompBuildAddition } from './comp-add-build-dialog';

function build(id: number, name: string, version = 1, role: BuildSummary['role'] = 'dps'): BuildSummary {
  return {
    id,
    name,
    description: null,
    role,
    category_id: 1,
    version,
    category_name: 'ZvZ',
    created_by_id: 1,
    created_by_username: 'officer',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 1,
    main_item_count: 1,
    archived_at: null,
    weapon_key: null,
    weapon_name: null,
  };
}

const page = (items: BuildSummary[]) => ({
  items,
  total_items: items.length,
  total_pages: 1,
  current_page: 1,
  limit: 200,
});

describe('CompAddBuildDialog', () => {
  const apiGet = vi.fn();
  let restoreShowModal: () => void;

  async function render(inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(CompAddBuildDialog);
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
    }
    return fixture;
  }

  beforeEach(async () => {
    apiGet.mockReset();
    apiGet.mockReturnValue(
      of(page([build(1, 'Great Hammer', 1, 'tank'), build(2, 'Hallowfall', 1, 'healer'), build(3, 'Hallowfall', 2, 'healer')])),
    );
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    restoreShowModal = () => {
      if (original) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
      } else {
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      }
    };
    await TestBed.configureTestingModule({
      imports: [CompAddBuildDialog],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get: apiGet } },
        TranslateService,
      ],
    }).compileComponents();
  });

  afterEach(() => {
    restoreShowModal();
  });

  it('lists build versions by name with the newest version first', async () => {
    const fixture = await render();
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.cab__option')).map((row) =>
      row.querySelector('.cab__title')?.textContent?.replace(/\s+/g, ' ').trim(),
    );

    expect(rows).toEqual(['Great Hammer v1', 'Hallowfall v2', 'Hallowfall v1']);
    expect(apiGet).toHaveBeenCalledWith(
      'api/comps/builds',
      expect.objectContaining({ sort: 'name', order: 'asc', mine: true }),
    );
  });

  it('leaves out builds that are already in the composition', async () => {
    const fixture = await render({ assignedIds: [1, 3] });
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.cab__option');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Hallowfall');
  });

  it('keeps Add disabled until a build is picked, then emits it with the quantity and resets', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const added: CompBuildAddition[] = [];
    fixture.componentInstance.add.subscribe((addition) => added.push(addition));
    const addButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Add',
    ) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    const option = root.querySelectorAll<HTMLButtonElement>('.cab__option')[1]!;
    option.click();
    (root.querySelector('[aria-label="Increase quantity"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(option.getAttribute('aria-pressed')).toBe('true');
    expect(addButton.disabled).toBe(false);
    addButton.click();
    fixture.detectChanges();

    expect(added).toHaveLength(1);
    expect(added[0]?.build.id).toBe(3);
    expect(added[0]?.quantity).toBe(2);
    expect(addButton.disabled).toBe(true);
    expect(root.querySelector('.cab__qty')?.textContent?.trim()).toBe('1');
  });

  it('disables Add while the parent is saving', async () => {
    const fixture = await render({ saving: true });
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('.cab__option')!.click();
    fixture.detectChanges();

    const addButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.trim() === 'Add',
    ) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
  });

  it('never lets the quantity drop below one', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const decrease = root.querySelector('[aria-label="Decrease quantity"]') as HTMLButtonElement;

    expect(decrease.disabled).toBe(true);
    expect(root.querySelector('.cab__qty')?.textContent?.trim()).toBe('1');
  });

  it('shows a retryable error instead of an empty list when loading fails', async () => {
    apiGet.mockReturnValue(throwError(() => new Error('offline')));
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.querySelector('.cab__option')).toBeNull();

    apiGet.mockReturnValue(of(page([build(1, 'Great Hammer')])));
    Array.from(root.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry'))!
      .click();
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
    }

    expect(root.querySelectorAll('.cab__option')).toHaveLength(1);
  });

  it('emits closed from the Close button', async () => {
    const fixture = await render();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Close')!
      .click();

    expect(closed).toHaveBeenCalledTimes(1);
  });
});
