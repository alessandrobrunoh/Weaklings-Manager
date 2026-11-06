import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuildImage, isAllowedIconUrl } from './build-image.js';

test('creates one PNG image even when item icons are unavailable', async () => {
  const image = await createBuildImage([
    {
      loadout: 'main',
      slot: 'weapon',
      openalbion_item_type: 'weapon',
      openalbion_item_id: 1,
      openalbion_item_name: 'Test weapon',
      openalbion_item_icon: null,
      openalbion_item_quality: 4,
      openalbion_item_enchantment: 0,
    },
  ]);

  assert.deepEqual([...image.subarray(0, 8)], [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
});

test('only the Albion render host over https is an allowed icon source', () => {
  assert.equal(
    isAllowedIconUrl('https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=4'),
    true,
  );
  for (const url of [
    null,
    undefined,
    '',
    'http://render.albiononline.com/v1/item/T8_MAIN_SWORD.png',
    'https://169.254.169.254/latest/meta-data',
    'http://localhost:8080/admin',
    'https://render.albiononline.com.evil.example/x.png',
    'https://evil.example/render.albiononline.com/x.png',
    'https://user:pass@render.albiononline.com/x.png',
    'https://render.albiononline.com:8443/x.png',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.equal(isAllowedIconUrl(url), false, String(url));
  }
});

test('a disallowed icon URL is never fetched and falls back to the placeholder', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('fetch must not be called');
  }) as typeof fetch;
  try {
    const image = await createBuildImage([
      {
        loadout: 'main',
        slot: 'weapon',
        openalbion_item_type: 'weapon',
        openalbion_item_id: 1,
        openalbion_item_name: 'Test weapon',
        openalbion_item_icon: 'http://169.254.169.254/latest/meta-data',
        openalbion_item_quality: 4,
        openalbion_item_enchantment: 0,
      },
    ]);
    assert.equal(calls, 0);
    assert.deepEqual([...image.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
