import assert from 'node:assert/strict';
import test from 'node:test';
import { brandName, withBrandName } from './branding.js';
import { createBaseEmbed, createResponseEmbed } from './theme.js';

test('embeds carry the tenant name inside a brand scope', async () => {
  await withBrandName('Night Owls', async () => {
    await Promise.resolve();
    const embed = createBaseEmbed({ title: 'Hello', category: 'Events' });
    assert.equal(embed.data.author?.name, '⚔️ NIGHT OWLS — EVENTS');
    assert.equal(embed.data.footer?.text, 'Night Owls • Albion Guild Manager');
    assert.equal(
      createResponseEmbed('info', 'Hi', 'Body').data.footer?.text,
      'Night Owls • Albion Guild Manager',
    );
  });
});

test('outside a scope, or with a blank name, embeds fall back to the GUILD_NAME setting', () => {
  const fallback = brandName();
  assert.equal(createBaseEmbed({ title: 'Hello' }).data.footer?.text, `${fallback} • Albion Guild Manager`);
  withBrandName('   ', () => {
    assert.equal(brandName(), fallback);
  });
  withBrandName(undefined, () => {
    assert.equal(brandName(), fallback);
  });
});

test('concurrent scopes do not leak names into each other', async () => {
  const seen = await Promise.all(
    ['Alpha', 'Bravo'].map((name) =>
      withBrandName(name, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return brandName();
      }),
    ),
  );
  assert.deepEqual(seen, ['Alpha', 'Bravo']);
});
