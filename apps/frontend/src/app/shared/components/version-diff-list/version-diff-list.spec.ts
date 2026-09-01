import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VersionDiffEntry } from '../../../features/comps/version-diff';
import { VersionDiffList } from './version-diff-list';

function render(entries: VersionDiffEntry[]) {
  const fixture = TestBed.createComponent(VersionDiffList);
  fixture.componentRef.setInput('entries', entries);
  fixture.componentRef.setInput('emptyLabel', 'These two versions are identical.');
  fixture.detectChanges();
  return fixture;
}

describe('VersionDiffList', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [VersionDiffList] }));

  it('says the versions are identical rather than showing an empty table', () => {
    const fixture = render([]);

    expect(fixture.nativeElement.querySelector('table')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('These two versions are identical.');
  });

  it('spells the kind of change out in words, so colour is never the only cue', () => {
    const fixture = render([
      { subject: 'Main · Weapon', before: 'Polehammer', after: 'Realmbreaker', change: 'changed' },
      { subject: 'Swap · Head', before: null, after: 'Knight Helmet', change: 'added' },
      { subject: 'Main · Cape', before: 'Demon Cape', after: null, change: 'removed' },
    ]);

    const lastColumn = [...fixture.nativeElement.querySelectorAll('tbody tr')].map(
      (row: Element) => row.querySelectorAll('td')[2].textContent?.trim(),
    );
    expect(lastColumn).toEqual(['Changed', 'Added', 'Removed']);
  });

  it('renders a missing side as a dash rather than blank', () => {
    const fixture = render([
      { subject: 'Swap · Head', before: null, after: 'Knight Helmet', change: 'added' },
    ]);

    const cells = fixture.nativeElement.querySelectorAll('tbody td');
    expect(cells[0].textContent.trim()).toBe('—');
    expect(cells[1].textContent.trim()).toBe('Knight Helmet');
  });

  it('lets wide content scroll inside its own container', () => {
    const fixture = render([
      { subject: 'Main · Weapon', before: 'a', after: 'b', change: 'changed' },
    ]);

    const wrapper = fixture.nativeElement.querySelector('table').parentElement as HTMLElement;
    expect(wrapper.style.overflowX).toBe('auto');
  });
});
