import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from './api.service';
import type {
  EnemyGuildDossier,
  EnemyGuildSummary,
  EnemyPlayerDossier,
  EnemyPlayerSummary,
  PaginatedData,
} from '../models/api.models';

/** Filters accepted by the enemy guild list endpoint. */
export interface ListEnemyGuildsParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: 'last_seen_at' | 'name';
  order?: 'asc' | 'desc';
}

/** Filters accepted by the enemy player list endpoint. */
export interface ListEnemyPlayersParams {
  page?: number;
  limit?: number;
  search?: string;
  guild_id?: number;
  role?: string;
  sort?: 'last_seen_at' | 'name';
  order?: 'asc' | 'desc';
}

/**
 * Client for the enemy identity dossiers (`intel.opponents.view`).
 *
 * Thin by design, same shape as `IntelService`: one method per backend route,
 * returning the unwrapped payload. Every rollup tally (battles fought, kills
 * traded, weapon histograms) is computed server-side from `enemy_player_battles`
 * at read time — this client never aggregates anything itself.
 */
@Injectable({ providedIn: 'root' })
export class EnemiesService {
  private readonly api = inject(ApiService);

  /** Paginated list of enemy guilds we have fought. */
  listGuilds(params: ListEnemyGuildsParams = {}): Observable<PaginatedData<EnemyGuildSummary>> {
    return this.api.get<PaginatedData<EnemyGuildSummary>>('/api/enemies/guilds', { ...params });
  }

  /** Full dossier for one enemy guild: identity, alias history, roster, weapon histogram. */
  getGuild(id: number): Observable<EnemyGuildDossier> {
    return this.api.get<EnemyGuildDossier>(`/api/enemies/guilds/${id}`);
  }

  /** Paginated list of enemy players we have fought. */
  listPlayers(params: ListEnemyPlayersParams = {}): Observable<PaginatedData<EnemyPlayerSummary>> {
    return this.api.get<PaginatedData<EnemyPlayerSummary>>('/api/enemies/players', { ...params });
  }

  /** Full dossier for one enemy player: identity and full battle-by-battle history. */
  getPlayer(id: number): Observable<EnemyPlayerDossier> {
    return this.api.get<EnemyPlayerDossier>(`/api/enemies/players/${id}`);
  }
}
