import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calendarChannelIds,
  destinationChannel,
  destinationChannelLabel,
} from './event-channels.js';

const routes = {
  events: '100',
  callToArms: '200',
  flashMass: '300',
};

test('flash masses route only to the flash channel, never as fallback', () => {
  assert.equal(destinationChannel({ event_kind: 'flash', call_to_arms: false }, routes), '300');
  assert.equal(
    destinationChannel({ event_kind: 'flash', call_to_arms: false }, {
      ...routes,
      flashMass: null,
    }),
    null,
  );
  // A CTA flag on a flash mass must not reroute it — the flag is importance.
  assert.equal(destinationChannel({ event_kind: 'flash', call_to_arms: true }, routes), '300');
});

test('organized events use one Call to Arms channel; CTA is only importance', () => {
  assert.equal(
    destinationChannel({ event_kind: 'organized', call_to_arms: false }, routes),
    '100',
  );
  assert.equal(
    destinationChannel({ event_kind: 'organized', call_to_arms: true }, routes),
    '100',
  );
  assert.equal(
    destinationChannel({ event_kind: 'organized', call_to_arms: true }, {
      ...routes,
      callToArms: null,
    }),
    '100',
  );
});

test('labels and calendar channels stay in sync with routing', () => {
  assert.equal(destinationChannelLabel({ event_kind: 'flash', call_to_arms: false }), 'flash mass');
  assert.equal(
    destinationChannelLabel({ event_kind: 'organized', call_to_arms: true }),
    'Call to Arms (priority)',
  );
  assert.deepEqual(calendarChannelIds(routes), ['100', '300']);
  assert.deepEqual(
    calendarChannelIds({ ...routes, callToArms: null, flashMass: null }),
    ['100'],
  );
});
