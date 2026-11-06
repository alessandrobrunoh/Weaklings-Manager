import type { ApiClient } from './client.js';
import type { PaginatedData } from './types.js';

/** A Discord user the officer picked with a user option. */
export interface ResolveTarget {
  id: string;
  username: string;
}

interface EnsureMemberResult {
  user_id: number;
  created: boolean;
  active: boolean;
}

/**
 * Resolves a Discord user picked with a user option to the backend's numeric `users.id`.
 *
 * Pass `isGuildMember = interaction.options.getMember('user') !== null`. A user option can name
 * someone outside this server; that target is refused here and never reaches the backend.
 * Otherwise one call, `POST api/members/ensure`, creates or reactivates the row, so a member who
 * has never logged in on the website can still be warned, given XP, or ranked.
 *
 * Returns `null` when the target is not a server member or the backend refuses.
 */
export async function resolveInternalUserId(
  api: ApiClient,
  target: ResolveTarget,
  isGuildMember: boolean,
): Promise<number | null> {
  if (!isGuildMember) return null;
  try {
    const ensured = await api.post<EnsureMemberResult>('api/members/ensure', {
      discord_id: target.id,
      username: target.username,
    });
    if (typeof ensured.user_id === 'number' && ensured.user_id > 0) return ensured.user_id;
  } catch {
    // Backend refused or was unreachable: the caller reports the account as not found.
  }
  return null;
}

export function asListItems<T>(data: PaginatedData<T> | T[] | null | undefined): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

export function parseMultiplier(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 1;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 1;
}

export function expiryFromDays(days: number | null): string | undefined {
  if (days === null || days <= 0) return undefined;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
