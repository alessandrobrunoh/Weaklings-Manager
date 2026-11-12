import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BuildRole } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import { BUILD_ROLES, RoleTag, roleGlyph, roleLabelKey } from './role-tag';

function render(role: BuildRole) {
  const fixture = TestBed.createComponent(RoleTag);
  fixture.componentRef.setInput('role', role);
  fixture.detectChanges();
  return fixture;
}

describe('RoleTag', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RoleTag],
      providers: [provideZonelessChangeDetection(), TranslateService],
    });
    TestBed.inject(TranslateService).use('en');
  });

  it('shows the localized label next to a hidden glyph', () => {
    const fixture = render('healer');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Healer');
    expect(root.querySelector('.role-tag__glyph')?.textContent?.trim()).toBe('H');
    expect(root.querySelector('.role-tag__glyph')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('follows the active language', () => {
    const fixture = render('support');
    TestBed.inject(TranslateService).use('it');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Supporto');
  });

  it('gives every role a distinct glyph and a translation key', () => {
    const glyphs = BUILD_ROLES.map(roleGlyph);
    expect(new Set(glyphs).size).toBe(BUILD_ROLES.length);
    for (const role of BUILD_ROLES) {
      expect(roleLabelKey(role)).toBe(`role.${role}`);
    }
  });

  it('does not encode the role in a per-role colour class', () => {
    const fixture = render('dps');
    const classes = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('*'),
      (node) => node.className,
    ).join(' ');

    expect(classes).not.toMatch(/dps|tank|healer|chip--/);
  });
});
