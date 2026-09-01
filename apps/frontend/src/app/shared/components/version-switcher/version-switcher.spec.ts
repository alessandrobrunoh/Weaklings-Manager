import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VersionRef } from '../../../core/models/api.models';
import { VersionSwitcher } from './version-switcher';

function render(versions: VersionRef[], currentId: number, canManage: boolean) {
  const fixture = TestBed.createComponent(VersionSwitcher);
  fixture.componentRef.setInput('versions', versions);
  fixture.componentRef.setInput('currentId', currentId);
  fixture.componentRef.setInput('canManage', canManage);
  fixture.detectChanges();
  return fixture;
}

describe('VersionSwitcher', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [VersionSwitcher] }));

  it('stays out of the way for a build nobody has versioned', () => {
    const fixture = render([{ id: 1, version: 1 }], 1, false);

    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('lists every sibling version once the group has more than one', () => {
    const fixture = render(
      [
        { id: 1, version: 1 },
        { id: 2, version: 2 },
        { id: 3, version: 3 },
      ],
      2,
      false,
    );

    const labels = [...fixture.nativeElement.querySelectorAll('nav button')].map((node: Element) =>
      node.textContent?.trim(),
    );
    expect(labels).toEqual(['v1', 'v2', 'v3']);
  });

  it('marks the version on screen for assistive technology, not only visually', () => {
    const fixture = render(
      [
        { id: 1, version: 1 },
        { id: 2, version: 2 },
      ],
      2,
      false,
    );

    const current = fixture.nativeElement.querySelector('button[aria-current="true"]');
    expect(current.textContent.trim()).toBe('v2');
  });

  it('emits the version the reader picked', () => {
    const fixture = render(
      [
        { id: 1, version: 1 },
        { id: 7, version: 2 },
      ],
      1,
      false,
    );
    const picked: number[] = [];
    fixture.componentInstance.select.subscribe((id) => picked.push(id));

    const buttons = fixture.nativeElement.querySelectorAll('nav button');
    buttons[1].click();

    expect(picked).toEqual([7]);
  });

  it('offers the create action only to someone who can manage the build', () => {
    const managed = render([{ id: 1, version: 1 }], 1, true);
    expect(managed.nativeElement.textContent).toContain('New version');

    const readOnly = render(
      [
        { id: 1, version: 1 },
        { id: 2, version: 2 },
      ],
      1,
      false,
    );
    expect(readOnly.nativeElement.textContent).not.toContain('New version');
  });
});
