import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChoiceGroup, type ChoiceOption } from './choice-group';

const TIERS: ChoiceOption[] = ['T4', 'T5', 'T6', 'T7', 'T8'].map((tier) => ({ id: tier, label: tier }));

function render(value: string | null, options: readonly ChoiceOption[] = TIERS) {
  const fixture = TestBed.createComponent(ChoiceGroup);
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('ariaLabel', 'Tier');
  fixture.detectChanges();
  return fixture;
}

const radios = (fixture: ReturnType<typeof render>): HTMLButtonElement[] => [
  ...fixture.nativeElement.querySelectorAll('[role="radio"]'),
];

describe('ChoiceGroup', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [ChoiceGroup] }));

  it('is a named radio group whose checked option is the one bound to value', () => {
    const fixture = render('T6');

    const group = fixture.nativeElement.querySelector('[role="radiogroup"]');
    expect(group.getAttribute('aria-label')).toBe('Tier');
    expect(radios(fixture).map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('keeps the whole group at a single Tab stop: the checked option', () => {
    const fixture = render('T7');

    expect(radios(fixture).map((radio) => radio.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
  });

  it('puts the first option in the Tab order when nothing is checked', () => {
    const fixture = render(null);

    expect(radios(fixture).map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it('emits the id of the option that was clicked, and nothing for the checked one', () => {
    const fixture = render('T8');
    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((id) => emitted.push(id));

    radios(fixture)[4].click();
    radios(fixture)[1].click();

    expect(emitted).toEqual(['T5']);
  });

  it('moves and selects with the arrow keys, wrapping at the ends', () => {
    const fixture = render('T6');
    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((id) => emitted.push(id));
    const keydown = (index: number, key: string) =>
      radios(fixture)[index].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    keydown(2, 'ArrowRight');
    keydown(2, 'ArrowLeft');
    keydown(0, 'ArrowLeft');
    keydown(4, 'ArrowRight');
    keydown(2, 'Home');
    keydown(2, 'End');

    expect(emitted).toEqual(['T7', 'T5', 'T8', 'T4', 'T4', 'T8']);
  });

  it('ignores clicks while disabled', () => {
    const fixture = render('T4');
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((id) => emitted.push(id));

    radios(fixture)[2].click();

    expect(emitted).toEqual([]);
  });

  it('shows an icon for an option that has one and always keeps the text label', () => {
    const fixture = render('', [
      { id: '', label: 'None' },
      { id: 'CLEAVE', label: 'Cleave', iconUrl: 'https://example.test/cleave.png' },
    ]);

    const chips = radios(fixture);
    expect(chips[0].querySelector('img')).toBeNull();
    expect(chips[1].querySelector('img')?.getAttribute('alt')).toBe('');
    expect(chips[1].textContent).toContain('Cleave');
  });
});
