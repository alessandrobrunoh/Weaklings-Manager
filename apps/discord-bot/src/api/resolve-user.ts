import type { ApiClient } from './client.js';
import type { DiscordUserProfile, PaginatedData, UserProfile } from './types.js';

/**
 * Resolves a Discord user to the backend's numeric `users.id`.
 *
 * Tries the target's own profile (bot impersonation via `X-Discord-Id`), then
 * `GET /api/users?username=` as the calling officer.
 */
export async function resolveInternalUserId(
  api: ApiClient,
  actorDiscordId: string,
  targetDiscordId: string,
  targetUsername: string,
): Promise<number | null> {
  try {
    const profile = await api.get<UserProfile>('api/users/me', targetDiscordId);
    if (typeof profile.id === 'number') return profile.id;
  } catch {
    // Target has no linked guild account, or the lookup failed.
  }

  try {
    const auth = await api.get<DiscordUserProfile>('api/auth/me', targetDiscordId);
    if (typeof auth.user_id === 'number' && auth.user_id > 0) return auth.user_id;
  } catch {
    // Fall through to directory search.
  }

  try {
    const result = await api.get<PaginatedData<UserProfile>>(
      'api/users',
      actorDiscordId,
      { username: targetUsername, page: 1, limit: 25 },
    );
    const items = result.items ?? [];
    const lower = targetUsername.toLowerCase();
    const exact = items.find((u) => u.username.toLowerCase() === lower);
    if (exact) return exact.id;
    if (items.length === 1) return items[0].id;
  } catch {
    // Directory search failed.
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
