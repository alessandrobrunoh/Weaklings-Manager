import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { EntityHeader, type EntityMenuItem } from './entity-header';

const ITEMS: EntityMenuItem[] = [
  { id: 'clone', label: 'Clone' },
  { id: 'share', label: 'Share', disabled: true },
  { id: 'compare', label: 'Compare' },
  { id: 'archive', label: 'Archive', danger: true, separatorBefore: true },
];

@Component({
  imports: [EntityHeader],
  template: `
    <button type="button" id="outside">outside</button>
    <app-entity-header
      title="ZvZ Mass 20"
      description="Main group"
      [menuItems]="items()"
      menuLabel="More actions"
      (menuSelect)="chosen.push($event)"
    >
      <span entityBadges class="badge">Archived</span>
      <span entityMeta>v2</span>
      <button entityPrimary type="button" class="primary">Edit</button>
      <div entitySummary class="summary">Players 20</div>
    </app-entity-header>
  `,
})
class Host {
  readonly items = signal<EntityMenuItem[]>(ITEMS);
  readonly chosen: string[] = [];
}

describe('EntityHeader', () => {
  let fixture: ComponentFixture<Host>;
  let root: HTMLElement;

  const trigger = () => root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  const menu = () => root.querySelector<HTMLElement>('[role="menu"]');
  const entries = () => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function key(target: Element, name: string): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    });
    fixture = TestBed.createComponent(Host);
    root = fixture.nativeElement as HTMLElement;
    await settle();
  });

  it('renders the title as the page heading with its badge, meta, primary action and summary', () => {
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('ZvZ Mass 20');
    expect(root.querySelector('.badge')?.textContent).toContain('Archived');
    expect(root.querySelector('.eh__meta')?.textContent).toContain('v2');
    expect(root.querySelector('.primary')?.textContent).toContain('Edit');
    expect(root.querySelector('.summary')?.textContent).toContain('Players 20');
    expect(root.textContent).toContain('Main group');
  });

  it('exposes a labelled menu button that is collapsed until opened', () => {
    expect(trigger().getAttribute('aria-label')).toBe('More actions');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(menu()).toBeNull();
  });

  it('opens on click, marks aria-expanded and focuses the first enabled entry', async () => {
    trigger().click();
    await settle();

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(menu()).not.toBeNull();
    expect(entries().map((entry) => entry.textContent?.trim())).toEqual([
      'Clone',
      'Share',
      'Compare',
      'Archive',
    ]);
    expect(document.activeElement).toBe(entries()[0]);
  });

  it('moves with the arrow keys, skipping disabled entries and wrapping', async () => {
    trigger().click();
    await settle();

    key(menu()!, 'ArrowDown');
    expect(document.activeElement).toBe(entries()[2]);
    key(menu()!, 'ArrowDown');
    expect(document.activeElement).toBe(entries()[3]);
    key(menu()!, 'ArrowDown');
    expect(document.activeElement).toBe(entries()[0]);
    key(menu()!, 'ArrowUp');
    expect(document.activeElement).toBe(entries()[3]);
    key(menu()!, 'Home');
    expect(document.activeElement).toBe(entries()[0]);
    key(menu()!, 'End');
    expect(document.activeElement).toBe(entries()[3]);
  });

  it('opens from the keyboard on the trigger with the arrow keys', async () => {
    trigger().focus();
    key(trigger(), 'ArrowUp');
    await settle();

    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(entries()[3]);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    trigger().click();
    await settle();

    key(menu()!, 'Escape');
    await settle();

    expect(menu()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('emits the chosen id, closes and returns focus to the trigger', async () => {
    trigger().click();
    await settle();

    entries()[2].click();
    await settle();

    expect(fixture.componentInstance.chosen).toEqual(['compare']);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('does not emit a disabled entry', async () => {
    trigger().click();
    await settle();

    entries()[1].click();
    await settle();

    expect(fixture.componentInstance.chosen).toEqual([]);
  });

  it('closes on an outside click', async () => {
    trigger().click();
    await settle();

    root.querySelector<HTMLButtonElement>('#outside')!.click();
    await settle();

    expect(menu()).toBeNull();
  });

  it('hides the menu button when there is nothing to put in it', async () => {
    fixture.componentInstance.items.set([]);
    await settle();

    expect(root.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });
});
