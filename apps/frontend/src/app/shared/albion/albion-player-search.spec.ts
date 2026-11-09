import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { ApiService } from '../../core/services/api.service';
import { foldName, matchesAlbionName, searchAlbionPlayers } from './albion-player-search';

describe('foldName', () => {
  it('ignores case and diacritics', () => {
    expect(foldName('Gálvdon')).toBe('galvdon');
    expect(foldName('GALVDON')).toBe('galvdon');
    expect(foldName('Søren')).toBe('soren');
    expect(foldName('Straße')).toBe('strasse');
  });
});

describe('matchesAlbionName', () => {
  it('matches partial, accented and differently cased input', () => {
    expect(matchesAlbionName('Gálvdon', 'ALV')).toBe(true);
    expect(matchesAlbionName('Gálvdon', '  galv ')).toBe(true);
    expect(matchesAlbionName('Gálvdon', 'xyz')).toBe(false);
    expect(matchesAlbionName('Gálvdon', '')).toBe(true);
  });
});

describe('searchAlbionPlayers', () => {
  it('queries the global search endpoint with the trimmed term and returns the players', async () => {
    const get = vi.fn().mockReturnValue(
      of({ guilds: [], players: [{ id: 'p1', name: 'Kay', in_guild: true }] }),
    );
    const players = await searchAlbionPlayers({ get } as unknown as ApiService, '  kay ');
    expect(get).toHaveBeenCalledWith('api/albion/search', { q: 'kay' });
    expect(players.map((p) => p.id)).toEqual(['p1']);
  });

  it('does not call the backend for a blank query', async () => {
    const get = vi.fn();
    expect(await searchAlbionPlayers({ get } as unknown as ApiService, '   ')).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('propagates backend failures to the caller', async () => {
    const get = vi.fn().mockReturnValue(throwError(() => new Error('boom')));
    await expect(searchAlbionPlayers({ get } as unknown as ApiService, 'kay')).rejects.toThrow('boom');
  });
});
