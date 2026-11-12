import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { Menu, type MenuItem } from './menu';

async function settle(fixture: ReturnType<typeof TestBed.createComponent<Menu>>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
}

describe('Menu', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Menu],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  function render(items: MenuItem[], inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(Menu);
    fixture.componentRef.setInput('label', 'Actions for ZvZ Mass 20');
    fixture.componentRef.setInput('items', items);
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    return fixture;
  }

  const trigger = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;

  it('renders nothing when there are no actions', async () => {
    const fixture = render([]);
    await settle(fixture);

    expect((fixture.nativeElement as HTMLElement).querySelector('button')).toBeNull();
  });

  it('names the icon trigger after its owner and opens a menu of menuitems', async () => {
    const fixture = render([
      { id: 'clone', label: 'Clone' },
      { id: 'archive', label: 'Archive', danger: true },
    ]);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    expect(trigger(root).getAttribute('aria-label')).toBe('Actions for ZvZ Mass 20');
    expect(trigger(root).getAttribute('aria-expanded')).toBe('false');

    trigger(root).click();
    await settle(fixture);

    expect(trigger(root).getAttribute('aria-expanded')).toBe('true');
    expect(
      Array.from(root.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim()),
    ).toEqual(['Clone', 'Archive']);
  });

  it('uses the visible text as the name of a labelled trigger', async () => {
    const fixture = render([{ id: 'csv', label: 'CSV' }], { triggerLabel: 'Export' });
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    expect(trigger(root).textContent).toContain('Export');
    expect(trigger(root).hasAttribute('aria-label')).toBe(false);
  });

  it('emits the id of the chosen entry and closes', async () => {
    const fixture = render([{ id: 'clone', label: 'Clone' }]);
    const chosen: string[] = [];
    fixture.componentInstance.itemSelect.subscribe((id) => chosen.push(id));
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    trigger(root).click();
    await settle(fixture);
    root.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await settle(fixture);

    expect(chosen).toEqual(['clone']);
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('does not emit a disabled entry', async () => {
    const fixture = render([
      { id: 'clone', label: 'Clone', disabled: true },
      { id: 'share', label: 'Share' },
    ]);
    const chosen: string[] = [];
    fixture.componentInstance.itemSelect.subscribe((id) => chosen.push(id));
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    trigger(root).click();
    await settle(fixture);
    root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0].click();

    expect(chosen).toEqual([]);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const fixture = render([{ id: 'clone', label: 'Clone' }]);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    trigger(root).click();
    await settle(fixture);
    root
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(fixture);

    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(root));
  });

  it('closes on a click outside', async () => {
    const fixture = render([{ id: 'clone', label: 'Clone' }]);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;

    trigger(root).click();
    await settle(fixture);
    document.body.click();
    await settle(fixture);

    expect(root.querySelector('[role="menu"]')).toBeNull();
  });
});
