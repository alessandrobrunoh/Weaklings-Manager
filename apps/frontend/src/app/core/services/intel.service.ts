import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from './api.service';
import type {
  GuildReport,
  MatchupReport,
  PaginatedData,
  ScoutOutcome,
  ScoutedCompDetail,
  ScoutedCompSummary,
  SimilarityHit,
  UpdateScoutRequest,
} from '../models/api.models';

/** Filters accepted by the scout list endpoint. */
export interface ScoutListParams {
  q?: string;
  category?: string;
  guild_id?: string;
  include_archived?: boolean;
  sort?: 'saved_at' | 'threat' | 'battles';
  page?: number;
  limit?: number;
}

/**
 * Client for the enemy-intel endpoints.
 *
 * Thin by design: every method maps to one backend route and returns the
 * unwrapped payload. The scoring, merging and tallying all happen server-side,
 * because they aggregate across battles, events and comps that this client
 * never holds in full.
 */
@Injectable({ providedIn: 'root' })
export class IntelService {
  private readonly api = inject(ApiService);

  /** Paginated scout library. */
  listScouts(params: ScoutListParams = {}): Observable<PaginatedData<ScoutedCompSummary>> {
    return this.api.get<PaginatedData<ScoutedCompSummary>>('/api/intel/scouts', { ...params });
  }

  /** Full dossier for one scout. */
  getScout(id: number): Observable<ScoutedCompDetail> {
    return this.api.get<ScoutedCompDetail>(`/api/intel/scouts/${id}`);
  }

  /** Renames, annotates, re-brackets or archives a scout. */
  updateScout(id: number, body: UpdateScoutRequest): Observable<ScoutedCompDetail> {
    return this.api.patch<ScoutedCompDetail>(`/api/intel/scouts/${id}`, body);
  }

  /** Permanently removes a scout and its battle links. */
  deleteScout(id: number): Observable<void | null> {
    return this.api.delete<null>(`/api/intel/scouts/${id}`);
  }

  /**
   * Derives enemy compositions from a stored battle.
   *
   * Pass `dryRun` to preview without writing; the call is idempotent either
   * way, so re-scouting an already-linked battle is safe.
   */
  scoutBattle(battleId: number, dryRun = false): Observable<ScoutOutcome[]> {
    return this.api.post<ScoutOutcome[]>(
      `/api/intel/scouts/from-battle/${battleId}${dryRun ? '?dry_run=true' : ''}`,
    );
  }

  /** Other scouts ranked by resemblance. */
  similarScouts(id: number, limit = 5): Observable<SimilarityHit[]> {
    return this.api.get<SimilarityHit[]>(`/api/intel/scouts/${id}/similar`, { limit });
  }

  /** Scouts ranked by resemblance to one of our comps. */
  threatsToComp(compId: number, limit = 5): Observable<SimilarityHit[]> {
    return this.api.get<SimilarityHit[]>(`/api/intel/comps/${compId}/threats`, { limit });
  }

  /**
   * The full guild report for a window.
   *
   * Served from a short-lived server-side cache, so repeated views and tab
   * switches cost nothing. Omit the bounds for the last 30 days.
   */
  report(from?: string, to?: string): Observable<GuildReport> {
    return this.api.get<GuildReport>('/api/intel/report', { from, to });
  }

  /** Recomputes the report, bypassing the cache. Officer-only. */
  refreshReport(from?: string, to?: string): Observable<GuildReport> {
    return this.api.post<GuildReport>(
      `/api/intel/report/refresh${from ? `?from=${from}&to=${to ?? ''}` : ''}`,
    );
  }

  /** The full matchup matrix, optionally narrowed to one scout. */
  matchups(scoutId?: number): Observable<MatchupReport> {
    return this.api.get<MatchupReport>('/api/intel/matchups', { scout_id: scoutId });
  }
}
