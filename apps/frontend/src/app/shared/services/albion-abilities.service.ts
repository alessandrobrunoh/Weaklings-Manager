import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { OpenAlbionItemAbilities } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';

/**
 * Loads the bundled Albion ability catalog once per session.
 *
 * Keyed by tier-stripped base identifier (`MAIN_SWORD`), because every tier of an item offers the
 * same spells. Mirrors {@link AlbionCatalogService}: the payload is static application data, so one
 * fetch serves every build page.
 */
@Injectable({ providedIn: 'root' })
export class AlbionAbilitiesService {
  private readonly api = inject(ApiService);
  private readonly abilities = signal<Record<string, OpenAlbionItemAbilities>>({});
  private loading: Promise<Readonly<Record<string, OpenAlbionItemAbilities>>> | null = null;

  async load(): Promise<Readonly<Record<string, OpenAlbionItemAbilities>>> {
    const cached = this.abilities();
    if (Object.keys(cached).length > 0) {
      return cached;
    }
    if (!this.loading) {
      this.loading = firstValueFrom(
        this.api.get<Record<string, OpenAlbionItemAbilities>>('api/openalbion/abilities'),
      )
        .then((abilities) => {
          this.abilities.set(abilities);
          return abilities;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }
}
