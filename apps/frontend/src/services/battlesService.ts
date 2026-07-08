/**
 * A guild summary in a battle.
 */
export interface BattleGuildSummary {
  id: string;
  name: string;
  players: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  winner: boolean;
}

/**
 * A battle summary for list views.
 */
export interface BattleSummary {
  battle_id: number;
  start_time: string;
  end_time: string;
  total_players: number;
  total_kills: number;
  total_fame: number;
  guilds: BattleGuildSummary[];
}

/**
 * A player in a battle.
 */
export interface BattlePlayer {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  kills: number;
  deaths: number;
  kill_fame: number;
  death_fame: number;
  item_power: number;
}

/**
 * A kill participant (killer or victim).
 */
export interface BattleKillParticipant {
  id: string;
  name: string;
  guild_id?: string;
  guild_name?: string;
}

/**
 * A kill event in a battle.
 */
export interface BattleKillEvent {
  event_id: number;
  time: string;
  killer: BattleKillParticipant;
  victim: BattleKillParticipant;
  killer_item_power: number;
  victim_item_power: number;
  total_kill_fame: number;
  raw: unknown;
}

/**
 * Full battle details including players and kill events.
 */
export interface BattleDetail extends BattleSummary {
  players: BattlePlayer[];
  kills: BattleKillEvent[];
}

/**
 * Paginated response wrapper for battles.
 */
export interface PaginatedBattles {
  items: BattleSummary[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

/**
 * Lists recent battles with pagination.
 */
export async function listBattles(
  page = 1,
  minPlayers = 10
): Promise<PaginatedBattles> {
  const params = new URLSearchParams({
    page: String(page),
    min_players: String(minPlayers),
  });

  const res = await fetch(`/api/battles?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch battles");
  const data = await res.json();
  return data.data as PaginatedBattles;
}

/**
 * Fetches detailed information about a specific battle.
 */
export async function getBattle(battleId: number): Promise<BattleDetail> {
  const res = await fetch(`/api/battles/${battleId}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error("Battle not found");
    throw new Error("Failed to fetch battle details");
  }
  const data = await res.json();
  return data.data as BattleDetail;
}

/**
 * Lists battles for the current user.
 * Throws an error with message "NOT_LINKED" if the user hasn't linked their Albion character.
 */
export async function listMyBattles(
  page = 1,
  limit = 50
): Promise<PaginatedBattles> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  const res = await fetch(`/api/battles/me?${params.toString()}`);
  if (!res.ok) {
    if (res.status === 400) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.detail || "NOT_LINKED");
    }
    throw new Error("Failed to fetch your battles");
  }
  const data = await res.json();
  return data.data as PaginatedBattles;
}
