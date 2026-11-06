import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Client/server contract: every `(method, path)` the frontend calls must exist in
 * the committed OpenAPI snapshot. Scans the sources and the specs too, so a new
 * fixture that calls a dead route (for example `PUT /api/splits/{id}`) fails here.
 */
const CONTRACTS = resolve(process.cwd(), '../contracts');
const SRC = resolve(process.cwd(), 'src');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const CALL_REGEX =
  /\.(get|post|put|patch|delete)\s*(?:<[^()\n]*>)?\s*\(\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g;
const RAW_REGEX =
  /requestRaw\s*(?:<[^()\n]*>)?\s*\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g;

/** Replaces `{param}` and `${expr}` segments with `{}`, and drops trailing slashes. */
function shape(path: string): string {
  // A template with a nested backtick is cut short by CALL_REGEX; drop the unterminated tail.
  const bare = path
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\$\{.*$/, '')
    .replace(/\/\d+(?=\/|$)/g, '/{}');
  return bare.length > 1 ? bare.replace(/\/+$/, '') : bare;
}

function documentedRoutes(): Set<string> {
  const doc = JSON.parse(readFileSync(join(CONTRACTS, 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const out = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      if (method in item) {
        out.add(`${method.toUpperCase()} ${shape(path)}`);
      }
    }
  }
  return out;
}

function allowlist(): Set<string> {
  const file = join(CONTRACTS, 'client-paths.allowlist');
  if (!existsSync(file)) {
    return new Set();
  }
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const [method, path] = line.split(' ');
        return `${method.toUpperCase()} ${shape(path)}`;
      }),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * The API path a literal names, or null for a non-API URL. Call sites spell it either
 * `/api/...` or `api/...`; both mean the same route because the base URL is empty.
 */
function apiPath(literal: string): string | null {
  if (literal.startsWith('/api/')) {
    return literal;
  }
  return literal.startsWith('api/') ? `/${literal}` : null;
}

/** Every `METHOD /api/...` literal the frontend issues through `ApiService`. */
function frontendCalls(): Array<{ key: string; file: string }> {
  const calls: Array<{ key: string; file: string }> = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('api.gen.ts')) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CALL_REGEX)) {
      const path = apiPath(match[2].slice(1, -1));
      if (path) {
        calls.push({ key: `${match[1].toUpperCase()} ${shape(path)}`, file });
      }
    }
    for (const match of text.matchAll(RAW_REGEX)) {
      const path = apiPath(match[2].slice(1, -1));
      if (path) {
        calls.push({ key: `${match[1]} ${shape(path)}`, file });
      }
    }
  }
  return calls;
}

describe('frontend API contract', () => {
  it('finds the frontend call sites it is meant to check', () => {
    expect(frontendCalls().length).toBeGreaterThan(100);
  });

  it('every called (method, path) exists in apps/contracts/openapi.json', () => {
    const documented = documentedRoutes();
    const allowed = allowlist();
    const missing = frontendCalls()
      .filter(({ key }) => !documented.has(key) && !allowed.has(key))
      .map(({ key, file }) => `${key} (${file.slice(SRC.length)})`);
    expect(missing).toEqual([]);
  });
});
