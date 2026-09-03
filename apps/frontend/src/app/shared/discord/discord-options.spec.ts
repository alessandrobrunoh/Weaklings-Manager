import { describe, expect, it } from 'vitest';

import type { DiscordChannelView, DiscordRoleView } from '../../core/models/api.models';
import {
  channelSelectOptions,
  filterDiscordChannels,
  roleSelectOptions,
  tagSelectOptions,
} from './discord-options';

const roles: DiscordRoleView[] = [
  { id: '1', name: 'Officer', position: 10, managed: false },
  { id: '2', name: 'Member', position: 1, managed: false },
];

const channels: DiscordChannelView[] = [
  {
    id: 'cat',
    name: 'Events',
    kind: 'category',
    type_id: 4,
    parent_id: null,
    position: 0,
    available_tags: [],
  },
  {
    id: 'text',
    name: 'announcements',
    kind: 'text',
    type_id: 0,
    parent_id: 'cat',
    position: 1,
    available_tags: [],
  },
  {
    id: 'forum',
    name: 'splits',
    kind: 'forum',
    type_id: 15,
    parent_id: 'cat',
    position: 2,
    available_tags: [
      { id: 'tag-1', name: 'Pending' },
      { id: 'tag-2', name: 'Done' },
    ],
  },
];

describe('discord-options', () => {
  it('keeps a saved role visible even when Discord no longer returns it', () => {
    const options = roleSelectOptions(roles, '999');
    expect(options[0]).toEqual({ id: '999', label: '999' });
    expect(options.map((option) => option.id)).toContain('1');
  });

  it('filters channels by picker kind and prefixes text names', () => {
    expect(filterDiscordChannels(channels, ['text']).map((channel) => channel.id)).toEqual(['text']);
    const options = channelSelectOptions(channels, ['text'], '');
    expect(options).toEqual([{ id: 'text', label: '#announcements', group: 'Events' }]);
  });

  it('lists forum tags for the selected forum only', () => {
    expect(tagSelectOptions(channels, 'forum', 'tag-2').map((option) => option.label)).toEqual([
      'Pending',
      'Done',
    ]);
    expect(tagSelectOptions(channels, '', 'old').map((option) => option.id)).toEqual(['old']);
  });
});
