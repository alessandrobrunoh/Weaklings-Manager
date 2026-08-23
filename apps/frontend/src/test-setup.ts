/**
 * Vitest environment setup.
 *
 * No zone.js import: this application runs zoneless, so pulling in the zone
 * patches here would test something the app never uses.
 */
import { getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
