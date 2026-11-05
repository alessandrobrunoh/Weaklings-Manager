/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/**
 * The inline script in index.html runs before Angular boots so the first paint
 * already has the right theme class. It must agree with ThemeService.
 */
function runPrebootScript(): void {
  const match = /<script>([\s\S]*?)<\/script>/.exec(indexHtml);
  expect(match).not.toBeNull();
  new Function(match![1])();
}

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query }));
}

describe('pre-boot theme script', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.style.colorScheme = '';
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('defaults to dark when nothing is stored, like ThemeService', () => {
    runPrebootScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('applies a stored light preference before first paint', () => {
    localStorage.setItem('alm.theme', 'light');
    runPrebootScript();
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows the OS for the system preference', () => {
    localStorage.setItem('alm.theme', 'system');
    mockSystemDark(false);
    runPrebootScript();
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('falls back to dark when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    runPrebootScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    vi.restoreAllMocks();
  });
});
