import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VersionDiffEntry } from '../../../features/comps/version-diff';
import { VersionDiffList } from './version-diff-list';

function render(entries: VersionDiffEntry[], inputs: Record<string, string> = {}) {
  const fixture = TestBed.createComponent(VersionDiffList);
  fixture.componentRef.setInput('entries', entries);
  fixture.componentRef.setInput('emptyLabel', 'These two versions are identical.');
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  return fixture;
}

const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim();

describe('VersionDiffList', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [VersionDiffList] }));

  it('says the versions are identical rather than showing an empty list', () => {
    const fixture = render([]);

    expect(fixture.nativeElement.querySelector('.entries')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('These two versions are identical.');
  });

  it('spells the kind of change out in words, so colour is never the only cue', () => {
    const fixture = render([
      { subject: 'Weapon', group: 'Main', before: 'Polehammer', after: 'Realmbreaker', change: 'changed' },
      { subject: 'Head', group: 'Swap', before: null, after: 'Knight Helmet', change: 'added' },
      { subject: 'Cape', group: 'Swap', before: 'Demon Cape', after: null, change: 'removed' },
    ]);

    const words = [...fixture.nativeElement.querySelectorAll('.entry__change')].map((node: Element) =>
      text(node),
    );
    expect(words[0]).toContain('Changed');
    expect(words[1]).toContain('Added');
    expect(words[2]).toContain('Removed');
    expect(words.map((word) => word?.[0])).toEqual(['~', '+', '−']);
    expect(words.every((word) => word?.includes('Change:'))).toBe(true);
  });

  it('lists entries under a heading per group, keeping the order given', () => {
    const fixture = render([
      { subject: 'Weapon', group: 'Main', before: 'a', after: 'b', change: 'changed' },
      { subject: 'Head', group: 'Main', before: 'c', after: 'd', change: 'changed' },
      { subject: 'Weapon', group: 'Swap', before: 'e', after: 'f', change: 'changed' },
    ]);

    const headings = [...fixture.nativeElement.querySelectorAll('.group__name')].map((node: Element) =>
      text(node),
    );
    expect(headings).toEqual(['Main', 'Swap']);
    const subjects = [...fixture.nativeElement.querySelectorAll('.entry__subject')].map(
      (node: Element) => text(node),
    );
    expect(subjects).toEqual(['Weapon', 'Head', 'Weapon']);
  });

  it('shows no heading for a flat list', () => {
    const fixture = render([{ subject: 'Pole Hammer v1', before: 'x5', after: 'x8', change: 'changed' }]);

    expect(fixture.nativeElement.querySelector('.group__name')).toBeNull();
  });

  it('shows only the tokens that changed, before then after, with the caller labels', () => {
    const fixture = render(
      [
        {
          subject: 'Weapon',
          group: 'Main',
          before: 'Polehammer',
          after: 'Polehammer',
          change: 'changed',
          tokens: [{ kind: 'spell', label: 'Q', before: 'Heroic Strike', after: 'Cleave' }],
        },
      ],
      { beforeLabel: 'v1', afterLabel: 'v2' },
    );

    const tokens = fixture.nativeElement.querySelectorAll('.token');
    expect(tokens).toHaveLength(1);
    expect(text(tokens[0].querySelector('.token__label'))).toBe('Q');
    const sides = [...tokens[0].querySelectorAll('.side')].map((node: Element) => text(node));
    expect(sides[0]).toContain('v1:');
    expect(sides[0]).toContain('Heroic Strike');
    expect(sides[1]).toContain('v2:');
    expect(sides[1]).toContain('Cleave');
  });

  it('renders a missing side as the none label rather than blank', () => {
    const fixture = render(
      [{ subject: 'Head', group: 'Swap', before: null, after: 'Knight Helmet', change: 'added' }],
      { noneLabel: 'Nessuno' },
    );

    const sides = [...fixture.nativeElement.querySelectorAll('.side')].map((node: Element) => text(node));
    expect(sides[0]).toContain('Nessuno');
    expect(sides[1]).toContain('Knight Helmet');
  });

  it('marks the arrow as decorative', () => {
    const fixture = render([{ subject: 'Head', before: 'a', after: 'b', change: 'changed' }]);

    expect(fixture.nativeElement.querySelector('.token__arrow').getAttribute('aria-hidden')).toBe('true');
  });
});
