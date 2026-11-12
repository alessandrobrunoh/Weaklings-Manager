import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { RowMenu } from './row-menu';

async function settle(fixture: ReturnType<typeof TestBed.createComponent<RowMenu>>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
}

describe('RowMenu', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RowMenu],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function render(items: { id: string; label: string; danger?: boolean }[]) {
    const fixture = TestBed.createComponent(RowMenu);
    fixture.componentRef.setInput('label', 'Actions for ZvZ Mass 20');
    fixture.componentRef.setInput('items', items);
    return fixture;
  }

  it('renders nothing when there are no actions', async () => {
    const fixture = render([]);
    await settle(fixture);

    expect((fixture.nativeElement as HTMLElement).querySelector('button')).toBeNull();
  });

  it('names the trigger after the row and opens a menu of menuitems', async () => {
    const fixture = render([
      { id: 'clone', label: 'Clone' },
      { id: 'archive', label: 'Archive', danger: true },
    ]);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;

    expect(trigger.getAttribute('aria-label')).toBe('Actions for ZvZ Mass 20');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click();
    await settle(fixture);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(root.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim())).toEqual([
      'Clone',
      'Archive',
    ]);
  });

  it('emits the id of the chosen entry and closes', async () => {
    const fixture = render([{ id: 'clone', label: 'Clone' }]);
    const chosen: string[] = [];
    fixture.componentInstance.select.subscribe((id) => chosen.push(id));
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
    await settle(fixture);
    root.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await settle(fixture);

    expect(chosen).toEqual(['clone']);
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes on Escape', async () => {
    const fixture = render([{ id: 'clone', label: 'Clone' }]);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
    await settle(fixture);
    root
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(fixture);

    expect(root.querySelector('[role="menu"]')).toBeNull();
  });
});
