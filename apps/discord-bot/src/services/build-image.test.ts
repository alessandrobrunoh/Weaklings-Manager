import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuildImage } from './build-image.js';

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
