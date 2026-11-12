import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { FilterBar } from './filter-bar';

@Component({
  imports: [FilterBar],
  template: `
    <app-filter-bar
      searchLabel="Search members"
      searchPlaceholder="Name"
      [query]="query()"
      [activeCount]="active()"
      (queryChange)="query.set($event)"
      (clear)="cleared = cleared + 1"
    >
      <span filterPrimary id="primary">Primary</span>
      <label class="filter-field"><span class="filter-field__label">Role</span><select id="role"></select></label>
    </app-filter-bar>
  `,
})
class Host {
  readonly query = signal('');
  readonly active = signal(0);
  cleared = 0;
}

describe('FilterBar', () => {
  let fixture: ComponentFixture<Host>;
  let root: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    });
    fixture = TestBed.createComponent(Host);
    root = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const input = () => root.querySelector<HTMLInputElement>('input')!;

  it('exposes a labelled search region with the search box', () => {
    expect(root.querySelector('[role="search"]')?.getAttribute('aria-label')).toBe('Search members');
    expect(root.querySelector('label.fb__search .sr-only')?.textContent).toBe('Search members');
    expect(input().placeholder).toBe('Name');
  });

  it('projects the primary slot and the facets', () => {
    expect(root.querySelector('.fb__top #primary')).not.toBeNull();
    expect(root.querySelector('.fb__panel #role')).not.toBeNull();
  });

  it('reports typed text and clears the search with the inline button', async () => {
    input().value = 'kris';
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.query()).toBe('kris');

    const clearSearch = root.querySelector<HTMLButtonElement>('.fb__clear')!;
    expect(clearSearch.getAttribute('aria-label')).toBe('Clear search');
    clearSearch.click();
    expect(fixture.componentInstance.query()).toBe('');
  });

  it('shows the filter count on the phone toggle and a clear button only when filters are active', async () => {
    expect(root.querySelector('.fb__toggle')?.textContent?.trim()).toBe('Filters');
    expect(root.querySelector('.fb__panel .btn--ghost')).toBeNull();

    fixture.componentInstance.active.set(2);
    fixture.detectChanges();

    expect(root.querySelector('.fb__toggle')?.textContent?.trim()).toBe('Filters (2)');
    root.querySelector<HTMLButtonElement>('.fb__panel .btn--ghost')!.click();
    expect(fixture.componentInstance.cleared).toBe(1);
  });

  it('opens and closes the phone panel with aria-expanded', () => {
    const toggle = root.querySelector<HTMLButtonElement>('.fb__toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.fb__panel--open')).not.toBeNull();
  });
});
