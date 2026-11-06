import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Design-system guard rails for the global stylesheet and feature sources.
 *
 * - Discord tokens are the only token layer: no leftover workbench overrides and no
 *   Plex-family fonts.
 * - Radii come from `--radius-*` tokens; literal lengths are forbidden outside them.
 * - Text tokens meet WCAG AA (4.5:1) on the shell, rail, sidebar and card surfaces,
 *   in both light and dark. This is the token-level contrast check; the rendered AXE
 *   run is FE-8.
 */

// Vitest runs from the frontend package root (see theme-preboot.spec.ts).
const SRC_DIR = resolve(process.cwd(), 'src');
const STYLES_PATH = join(SRC_DIR, 'styles.css');
const SOURCE_EXTENSIONS = ['.ts', '.html', '.css'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    const isSource = SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
    return isSource && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const relativeToSrc = (path: string): string => relative(SRC_DIR, path);

describe('design system: Discord token layer', () => {
  it('ships no leftover workbench override layer', () => {
    const offenders = sourceFiles(SRC_DIR).filter((file) =>
      /zed\s+workbench/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(relativeToSrc)).toEqual([]);
  });

  it('does not reference Plex-family fonts anywhere in src', () => {
    const offenders = sourceFiles(SRC_DIR).filter((file) =>
      /IBM\s+Plex/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(relativeToSrc)).toEqual([]);
  });

  it('keeps the Discord font stack (Nunito display, Inter sans, Geist Mono)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    expect(css).toMatch(/--font-display:\s*'Nunito'/);
    expect(css).toMatch(/--font-sans:\s*'Inter'/);
    expect(css).toMatch(/--font-mono:\s*'Geist Mono'/);
  });
});

/** Radius values a stylesheet may use: a `--radius-*` token, or a non-length keyword. */
const ALLOWED_RADIUS_VALUE =
  /^(var\(--radius-[a-z0-9-]+\)|calc\(var\(--radius-[a-z0-9-]+\) - \d+px\)|0|50%|inherit|initial|unset|none)$/;

function radiusViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const declaration = /border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;{}"'`\n]+)/g;
  for (const match of source.matchAll(declaration)) {
    const value = match[1].trim();
    if (ALLOWED_RADIUS_VALUE.test(value)) {
      continue;
    }
    for (const part of value.split(/\s+/)) {
      if (!ALLOWED_RADIUS_VALUE.test(part)) {
        violations.push(`${relativeToSrc(file)}: border-radius ${value}`);
      }
    }
  }
  const arbitrary = /rounded(?:-[a-z]+)?-\[([^\]]+)\]/g;
  for (const match of source.matchAll(arbitrary)) {
    if (!/^var\(--radius-[a-z0-9-]+\)$/.test(match[1])) {
      violations.push(`${relativeToSrc(file)}: ${match[0]}`);
    }
  }
  return violations;
}

describe('design system: radii come from tokens', () => {
  it('forbids literal border radii outside the --radius-* tokens', () => {
    const violations = sourceFiles(SRC_DIR).flatMap((file) =>
      radiusViolations(file, readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('flags literal radii (self-check of the rule)', () => {
    expect(radiusViolations('x.ts', 'border-radius: 6px;')).toHaveLength(1);
    expect(radiusViolations('x.ts', 'border-radius: var(--radius-cards, 2px);')).toHaveLength(2);
    expect(
      radiusViolations('x.ts', 'border-radius: 0 var(--radius-sm) var(--radius-sm) 0;'),
    ).toEqual([]);
    expect(radiusViolations('x.ts', 'class="rounded-[var(--radius-cards)]"')).toEqual([]);
    expect(radiusViolations('x.ts', 'class="rounded-[6px]"')).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- contrast */

type Palette = Map<string, string>;

/** Collects `--name: value;` declarations from the blocks whose selector matches. */
function declarationsFor(css: string, selectorPattern: RegExp): Palette {
  const palette: Palette = new Map();
  const block = /([^{}]+)\{([^{}]*)\}/g;
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of uncommented.matchAll(block)) {
    if (!selectorPattern.test(match[1].trim())) {
      continue;
    }
    for (const decl of match[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      palette.set(decl[1], decl[2].trim());
    }
  }
  return palette;
}

function resolveColor(name: string, palette: Palette, depth = 0): [number, number, number] | null {
  const value = palette.get(name);
  if (value === undefined || depth > 8) {
    return null;
  }
  const ref = /^var\((--[a-z0-9-]+)(?:,[^)]*)?\)$/i.exec(value);
  if (ref) {
    return resolveColor(ref[1], palette, depth + 1);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(STYLES_PATH, 'utf8');
const themeTokens = declarationsFor(css, /(^|\s)@theme$/);
const darkTokens = new Map([...themeTokens, ...declarationsFor(css, /(^|\s):root,\s*html\.dark$/)]);
const lightTokens = new Map([
  ...themeTokens,
  ...declarationsFor(css, /(^|\s):root,\s*html\.dark$/),
  ...declarationsFor(css, /(^|\s)html\.light$/),
]);

/** Text tokens that must stay readable on the shell, rail, sidebar and card surfaces. */
const TEXT_TOKENS = [
  '--color-text',
  '--color-text-secondary',
  '--color-text-tertiary',
  '--color-text-muted',
  '--color-text-steel',
];
const SURFACE_TOKENS = [
  '--color-bg',
  '--color-chrome',
  '--color-rail',
  '--color-surface',
  '--color-surface-2',
];

describe('design system: AA contrast on shell, rail, sidebar and cards', () => {
  for (const [mode, tokens] of [
    ['light', lightTokens],
    ['dark', darkTokens],
  ] as const) {
    it(`meets 4.5:1 for text tokens on every surface (${mode})`, () => {
      const failures: string[] = [];
      for (const text of TEXT_TOKENS) {
        const fg = resolveColor(text, tokens);
        expect(fg, `${text} must resolve to a hex colour in ${mode}`).not.toBeNull();
        for (const surface of SURFACE_TOKENS) {
          const bg = resolveColor(surface, tokens);
          expect(bg, `${surface} must resolve to a hex colour in ${mode}`).not.toBeNull();
          const ratio = contrastRatio(fg!, bg!);
          if (ratio < 4.5) {
            failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
