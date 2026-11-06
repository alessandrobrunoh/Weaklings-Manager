import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Client/server contract: every `(method, path)` the bot calls must exist in the
 * committed OpenAPI snapshot. Scans the sources and the tests, so a new fixture
 * that calls a dead route fails here.
 */
const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const CALL_REGEX =
  /\.(get|post|put|patch|delete)\s*(?:<[^()\n]*>)?\s*\(\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g;

/** Replaces `{param}` and `${expr}` segments with `{}`, and drops trailing slashes. */
function shape(path: string): string {
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

/** Every `METHOD /api/...` literal the bot issues through `ApiClient` (`api/...` paths). */
function botCalls(): Array<{ key: string; file: string }> {
  const calls: Array<{ key: string; file: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CALL_REGEX)) {
      const literal = match[2].slice(1, -1);
      if (literal.startsWith('api/')) {
        calls.push({ key: `${match[1].toUpperCase()} ${shape('/' + literal)}`, file });
      }
    }
  }
  return calls;
}

test('bot API contract finds the call sites it is meant to check', () => {
  assert.ok(botCalls().length > 50, 'expected the bot to issue many api/ calls');
});

test('every bot-called (method, path) exists in apps/contracts/openapi.json', () => {
  const documented = documentedRoutes();
  const allowed = allowlist();
  const missing = botCalls()
    .filter(({ key }) => !documented.has(key) && !allowed.has(key))
    .map(({ key, file }) => `${key} (${file.slice(SRC.length)})`);
  assert.deepEqual(missing, []);
});
