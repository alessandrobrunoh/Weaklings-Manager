import { describe, expect, it } from 'vitest';

import {
  addCurrentUserToParticipants,
  isSplitAwaitingEvent,
  isSplitBatchSelectable,
} from './splits';

describe('split creation participants', () => {
  it('adds the authenticated user and redistributes weights to 100%', () => {
    const participants = addCurrentUserToParticipants(
      [
        { raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 100 },
        { raw_name: 'Bob', user_id: 11, username: 'Bob', weight: 0 },
      ],
      { user_id: 12, username: 'CurrentUser' },
    );

    expect(participants).toEqual([
      { raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 33.34 },
      { raw_name: 'Bob', user_id: 11, username: 'Bob', weight: 33.33 },
      { raw_name: 'CurrentUser', user_id: 12, username: 'CurrentUser', weight: 33.33 },
    ]);
    expect(participants.reduce((sum, participant) => sum + participant.weight, 0)).toBe(100);
  });

  it('does not duplicate the authenticated user when reopening the dialog', () => {
    const participants = [
      { raw_name: 'CurrentUser', user_id: 12, username: 'CurrentUser', weight: 100 },
    ];

    expect(
      addCurrentUserToParticipants(participants, { user_id: 12, username: 'CurrentUser' }),
    ).toEqual(participants);
  });

  it('leaves the draft unchanged when no authenticated profile is available', () => {
    const participants = [{ raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 100 }];

    expect(addCurrentUserToParticipants(participants, null)).toEqual(participants);
  });
});

describe('linked event split actions', () => {
  it('excludes awaiting_event splits from batch completion', () => {
    expect(isSplitBatchSelectable('pending')).toBe(true);
    expect(isSplitBatchSelectable('awaiting_event')).toBe(false);
  });

  it('identifies the state that must show the event-waiting message', () => {
    expect(isSplitAwaitingEvent('awaiting_event')).toBe(true);
    expect(isSplitAwaitingEvent('pending')).toBe(false);
  });
});
