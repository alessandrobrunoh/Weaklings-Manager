import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { Tabs, type TabOption } from './tabs';

const OPTIONS: readonly TabOption[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'guilds', label: 'Guilds', count: 4 },
  { id: 'hidden', label: 'Locked', disabled: true },
  { id: 'players', label: 'Players' },
];

describe('Tabs', () => {
  async function create(
    options: readonly TabOption[] = OPTIONS,
    active = 'overview',
  ): Promise<{ fixture: ComponentFixture<Tabs>; emitted: string[] }> {
    const emitted: string[] = [];
    await TestBed.configureTestingModule({
      imports: [Tabs],
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(Tabs);
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('active', active);
    fixture.componentRef.setInput('ariaLabel', 'Sections');
    fixture.componentInstance.activeChange.subscribe((id) => emitted.push(id));
    fixture.detectChanges();
    return { fixture, emitted };
  }

  const tablist = (fixture: ComponentFixture<Tabs>) =>
    fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
  const tabs = (fixture: ComponentFixture<Tabs>) =>
    Array.from(fixture.nativeElement.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];

  it('renders a labelled tablist with aria-selected on the active tab only', async () => {
    const { fixture } = await create();
    expect(tablist(fixture).getAttribute('aria-label')).toBe('Sections');
    const rendered = tabs(fixture);
    expect(rendered.length).toBe(4);
    expect(rendered.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(rendered.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('shows a count after the label when given', async () => {
    const { fixture } = await create();
    expect(tabs(fixture)[1].textContent).toContain('Guilds');
    expect(tabs(fixture)[1].querySelector('.tab__count')?.textContent?.trim()).toBe('4');
    expect(tabs(fixture)[0].querySelector('.tab__count')).toBeNull();
  });

  it('activates the next enabled tab on ArrowRight and skips disabled ones', async () => {
    const { fixture, emitted } = await create(OPTIONS, 'guilds');
    tablist(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(emitted).toEqual(['players']);
  });

  it('wraps with ArrowLeft and jumps with Home and End', async () => {
    const { fixture, emitted } = await create();
    const list = tablist(fixture);
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(emitted).toEqual(['players', 'players', 'overview']);
  });

  it('emits the chosen id on click but not for a disabled tab', async () => {
    const { fixture, emitted } = await create();
    tabs(fixture)[1].click();
    tabs(fixture)[2].click();
    expect(emitted).toEqual(['guilds']);
  });

  it('renders anchors with aria-current in the routed variant', async () => {
    const routed: readonly TabOption[] = [
      { id: 'a', label: 'A', link: ['/a'] },
      { id: 'b', label: 'B', link: ['/b'], queryParams: { period: '30d' } },
    ];
    const { fixture } = await create(routed, 'b');
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe('Sections');
    const anchors = Array.from(root.querySelectorAll('a'));
    expect(anchors.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(anchors[1].getAttribute('href')).toBe('/b?period=30d');
  });
});
