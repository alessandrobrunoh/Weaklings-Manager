import type {
  DiscordChannelKind,
  DiscordChannelView,
  DiscordForumTagView,
  DiscordRoleView,
} from '../../core/models/api.models';
import type { SearchableSelectOption } from '../components/searchable-select/searchable-select';

const CHANNEL_PREFIX: Record<string, string> = {
  text: '#',
  forum: '#',
  voice: '',
  category: '',
};

/** Turns Discord roles into searchable-select options. */
export function roleSelectOptions(
  roles: readonly DiscordRoleView[],
  selectedId = '',
): SearchableSelectOption[] {
  const options = roles.map((role) => ({
    id: role.id,
    label: role.name,
  }));
  return withUnknownOption(options, selectedId);
}

/** Turns Discord roles into multi-select options, keeping unknown saved ids visible. */
export function roleSelectOptionsMany(
  roles: readonly DiscordRoleView[],
  selectedIds: readonly string[] = [],
): SearchableSelectOption[] {
  const options = roles.map((role) => ({
    id: role.id,
    label: role.name,
  }));
  return withUnknownOptions(options, selectedIds);
}

/** Filters guild channels to the kinds a given setting accepts. */
export function filterDiscordChannels(
  channels: readonly DiscordChannelView[],
  kinds: readonly DiscordChannelKind[],
): DiscordChannelView[] {
  const allowed = new Set(kinds);
  return channels.filter((channel) => allowed.has(channel.kind as DiscordChannelKind));
}

/** Turns Discord channels into searchable-select options grouped by parent category. */
export function channelSelectOptions(
  channels: readonly DiscordChannelView[],
  kinds: readonly DiscordChannelKind[],
  selectedId = '',
): SearchableSelectOption[] {
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  const options = filterDiscordChannels(channels, kinds).map((channel) => {
    const prefix = CHANNEL_PREFIX[channel.kind] ?? '';
    const parentName = channel.parent_id ? names.get(channel.parent_id) : undefined;
    return {
      id: channel.id,
      label: prefix ? `${prefix}${channel.name}` : channel.name,
      group: parentName,
    };
  });
  return withUnknownOption(options, selectedId);
}

/** Forum tags for the currently selected forum channel. */
export function tagSelectOptions(
  channels: readonly DiscordChannelView[],
  forumChannelId: string,
  selectedId = '',
): SearchableSelectOption[] {
  const forum = channels.find((channel) => channel.id === forumChannelId);
  const tags: readonly DiscordForumTagView[] = forum?.available_tags ?? [];
  const options = tags.map((tag) => ({
    id: tag.id,
    label: tag.name,
  }));
  return withUnknownOption(options, selectedId);
}

function withUnknownOption(
  options: SearchableSelectOption[],
  selectedId: string,
): SearchableSelectOption[] {
  if (!selectedId || options.some((option) => option.id === selectedId)) {
    return options;
  }
  return [{ id: selectedId, label: selectedId }, ...options];
}

function withUnknownOptions(
  options: SearchableSelectOption[],
  selectedIds: readonly string[],
): SearchableSelectOption[] {
  const known = new Set(options.map((option) => option.id));
  const extras = selectedIds
    .filter((id) => id && !known.has(id))
    .map((id) => ({ id, label: id }));
  return extras.length ? [...extras, ...options] : options;
}
