import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from './client.js';
import { resolveInternalUserId } from './resolve-user.js';

function api(items: Array<{ id: number; username: string }>): ApiClient {
  return {
    get: async (path: string) => {
      if (path === 'api/users/me' || path === 'api/auth/me') {
        throw new Error('unlinked');
      }
      if (path === 'api/users') {
        return { items, total_items: items.length, total_pages: 1, current_page: 1, limit: 25 };
      }
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as ApiClient;
}

test('resolveInternalUserId returns a unique exact username', async () => {
  const id = await resolveInternalUserId(api([
    { id: 4, username: 'alice-alt' },
    { id: 5, username: 'Alice' },
  ]), 'actor', 'target', 'alice');
  assert.equal(id, 5);
});

test('resolveInternalUserId rejects a single partial username match', async () => {
  const id = await resolveInternalUserId(
    api([{ id: 9, username: 'alice-other' }]),
    'actor',
    'target',
    'alice',
  );
  assert.equal(id, null);
});

test('resolveInternalUserId rejects two exact username matches', async () => {
  const id = await resolveInternalUserId(api([
    { id: 1, username: 'alice' },
    { id: 2, username: 'Alice' },
  ]), 'actor', 'target', 'alice');
  assert.equal(id, null);
});
