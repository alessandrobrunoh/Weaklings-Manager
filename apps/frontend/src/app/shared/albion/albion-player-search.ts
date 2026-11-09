import { firstValueFrom } from 'rxjs';

import type { AlbionPlayer, AlbionSearchResult } from '../../core/models/api.models';
import type { ApiService } from '../../core/services/api.service';

/** Characters that do not decompose under NFD but should still match their plain-Latin spelling. */
const SPECIAL_LETTERS: Record<string, string> = {
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
};

/**
 * Lower-cases a name and strips diacritics so `Gálvdon`, `GALVDON` and `galvdon` compare equal.
 * Mirrors `fold_name` in the backend's `albion/service.rs`.
 */
export function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øłđðßæœþ]/g, (letter) => SPECIAL_LETTERS[letter] ?? letter);
}

/**
 * Searches every Albion player (not only the guild) through `GET /api/albion/search`. The backend
 * trims and folds the query, merges the guild roster in first and flags `in_guild`, and answers
 * from the roster alone when Albion's own search is down, so callers just render the list.
 */
export async function searchAlbionPlayers(api: ApiService, query: string): Promise<AlbionPlayer[]> {
  const q = query.trim();
  if (!q) {
    return [];
  }
  const result = await firstValueFrom(api.get<AlbionSearchResult>('api/albion/search', { q }));
  return result.players ?? [];
}

/**
 * Case- and diacritic-insensitive substring match used to filter an already loaded list while a
 * remote search is still in flight.
 */
export function matchesAlbionName(name: string, query: string): boolean {
  const needle = foldName(query.trim());
  return !needle || foldName(name).includes(needle);
}
