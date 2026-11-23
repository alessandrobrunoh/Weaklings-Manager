import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiService } from '../core/services/api.service';
import { ChristmasDecorations } from './christmas-decorations';
import { ChristmasSettings } from './christmas-settings';

describe('ChristmasDecorations', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('starts the scene when the platform settings arrive after the first render', async () => {
    const enabled = { enabled: true, preset: 1, intensity: 1, layers: null };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get: () => of(enabled), put: () => of(enabled) } },
      ],
    });
    const fixture = TestBed.createComponent(ChristmasDecorations);
    await fixture.whenStable();

    // The settings request answers after the scene engine exists, as in the browser.
    const settings = TestBed.inject(ChristmasSettings);
    await settings.load();
    await fixture.whenStable();

    expect(settings.active()).toEqual(['snow', 'caps']);
    expect(document.body.classList.contains('fx-caps')).toBe(true);
    fixture.destroy();
    expect(document.body.classList.contains('fx-caps')).toBe(false);
  });
});
