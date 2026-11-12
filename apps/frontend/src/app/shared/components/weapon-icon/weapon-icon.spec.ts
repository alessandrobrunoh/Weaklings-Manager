import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { WeaponIcon } from './weapon-icon';

function render(inputs: Record<string, unknown>) {
  const fixture = TestBed.createComponent(WeaponIcon);
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  return fixture;
}

describe('WeaponIcon', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [WeaponIcon],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('renders the weapon from a weapon key as a decorative image', () => {
    const fixture = render({ weaponKey: 'weapon:MAIN_SWORD', fallback: 'D' });
    const img = (fixture.nativeElement as HTMLElement).querySelector('img')!;

    expect(img.getAttribute('src')).toContain('/v1/item/T8_MAIN_SWORD.png');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('shows the fallback when the build has no weapon', () => {
    const fixture = render({ weaponKey: null, fallback: 'H' });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent?.trim()).toBe('H');
  });

  it('swaps the broken image for the fallback when the CDN has no render', () => {
    const fixture = render({ weaponKey: 'weapon:SOULSCYTHE', fallback: 'B' });
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent?.trim()).toBe('B');
  });

  it('uses the compact size when asked', () => {
    const fixture = render({ weaponKey: null, size: 'sm' });

    expect((fixture.nativeElement as HTMLElement).classList.contains('weapon-icon--sm')).toBe(true);
  });
});
