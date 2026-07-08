/**
 * A member of the configured Albion Online guild's roster.
 */
export interface AlbionGuildMember {
  id: string;
  name: string;
  guild_id?: string;
  guild_name?: string;
  kill_fame?: number;
  death_fame?: number;
}

/**
 * The current Discord user's Albion Online player link status.
 */
export interface AlbionLinkStatus {
  linked: boolean;
  albion_player_id?: string;
  albion_player_name?: string;
  linked_at?: string;
}

/**
 * Fetches the current user's Albion player link status.
 */
export async function fetchLinkStatus(): Promise<AlbionLinkStatus> {
  const res = await fetch("/api/albion/link/me");
  if (!res.ok) throw new Error("Failed to fetch link status");
  const data = await res.json();
  return data.data as AlbionLinkStatus;
}

/**
 * Searches the configured guild's roster by an optional name substring.
 */
export async function fetchGuildRoster(q?: string): Promise<AlbionGuildMember[]> {
  const url = q
    ? `/api/albion/guild/roster?q=${encodeURIComponent(q)}&limit=20`
    : "/api/albion/guild/roster?limit=20";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch guild roster");
  const data = await res.json();
  return data.data.items as AlbionGuildMember[];
}

/**
 * Links the current Discord account to an Albion player from the guild roster.
 */
export async function linkPlayer(albionPlayerId: string, albionPlayerName: string): Promise<AlbionLinkStatus> {
  const res = await fetch("/api/albion/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ albion_player_id: albionPlayerId, albion_player_name: albionPlayerName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.detail || "Failed to link player");
  }
  const data = await res.json();
  return data.data as AlbionLinkStatus;
}

/**
 * Removes the current Discord account's Albion player link.
 */
export async function unlinkPlayer(): Promise<void> {
  const res = await fetch("/api/albion/link", { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.detail || "Failed to unlink player");
  }
}
