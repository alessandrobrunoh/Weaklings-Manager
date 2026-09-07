import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiscordUserProfile } from '../models/api.models';
import { AuthService } from './auth.service';
import { BrandingService, normalizeHex, readableInkOn } from './branding.service';

function profileWith(brand: DiscordUserProfile['brand']): DiscordUserProfile {
  return { brand } as DiscordUserProfile;
}

describe('normalizeHex', () => {
  it('accepts both hex shapes and lowercases them', () => {
    expect(normalizeHex('#DC2626')).toBe('#dc2626');
    expect(normalizeHex('  #abc ')).toBe('#abc');
  });

  /** The value ends up in a style attribute, so anything else is a hole. */
  it('rejects everything that is not a hex triplet', () => {
    for (const value of [
      'red',
      'var(--color-error)',
      '#dc2626; background: url(https://evil)',
      'rgb(1,2,3)',
      '#12345',
      '',
      null,
      undefined,
    ]) {
      expect(normalizeHex(value)).toBeNull();
    }
  });
});

describe('readableInkOn', () => {
  it('puts white on dark fills and near-black on light ones', () => {
    expect(readableInkOn('#5865f2')).toBe('#ffffff');
    expect(readableInkOn('#dc2626')).toBe('#ffffff');
    expect(readableInkOn('#fde047')).toBe('#1d1e26');
    expect(readableInkOn('#fff')).toBe('#1d1e26');
  });
});

describe('BrandingService', () => {
  const profile = signal<DiscordUserProfile | null>(null);
  let branding: BrandingService;

  const root = () => document.documentElement;
  const brandVar = (name: string) => root().style.getPropertyValue(name);

  beforeEach(() => {
    profile.set(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: { profile } },
      ],
    });
    branding = TestBed.inject(BrandingService);
    TestBed.tick();
  });

  afterEach(() => {
    for (const name of [
      '--brand-primary',
      '--brand-secondary',
      '--brand-tertiary',
      '--color-on-primary',
    ]) {
      root().style.removeProperty(name);
    }
  });

  it('paints the session tenant colours and the ink that reads on them', () => {
    profile.set(profileWith({ primary: '#dc2626', secondary: '#7f1d1d', tertiary: '#f59e0b' }));
    TestBed.tick();

    expect(brandVar('--brand-primary')).toBe('#dc2626');
    expect(brandVar('--brand-secondary')).toBe('#7f1d1d');
    expect(brandVar('--brand-tertiary')).toBe('#f59e0b');
    expect(brandVar('--color-on-primary')).toBe('#ffffff');
  });

  /** Absent means "product default", so the variables have to come off again. */
  it('clears the variables for a tenant with no colours', () => {
    profile.set(profileWith({ primary: '#dc2626' }));
    TestBed.tick();
    profile.set(profileWith(null));
    TestBed.tick();

    expect(brandVar('--brand-primary')).toBe('');
    expect(brandVar('--color-on-primary')).toBe('');
  });

  it('never lets a non-hex colour reach the style attribute', () => {
    profile.set(profileWith({ primary: '#dc2626; background: url(https://evil)' }));
    TestBed.tick();

    expect(brandVar('--brand-primary')).toBe('');
    expect(root().getAttribute('style') ?? '').not.toContain('evil');
  });

  it('shows a preview over the session colours until it is dropped', () => {
    profile.set(profileWith({ primary: '#dc2626' }));
    TestBed.tick();

    branding.preview({ primary: '#22c55e' });
    TestBed.tick();
    expect(brandVar('--brand-primary')).toBe('#22c55e');

    branding.clearPreview();
    TestBed.tick();
    expect(brandVar('--brand-primary')).toBe('#dc2626');
  });
});
