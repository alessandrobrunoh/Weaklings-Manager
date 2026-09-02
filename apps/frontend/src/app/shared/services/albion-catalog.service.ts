import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { OpenAlbionItem } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { normalizeAlbionEquipmentName } from '../data/albion-equipment-catalog';

@Injectable({ providedIn: 'root' })
export class AlbionCatalogService {
  private readonly api = inject(ApiService);
  private readonly items = signal<OpenAlbionItem[]>([]);
  /** True once the first successful response (even an empty one) has been received. */
  private readonly loaded = signal(false);
  private loading: Promise<readonly OpenAlbionItem[]> | null = null;

  async load(): Promise<readonly OpenAlbionItem[]> {
    if (this.loaded()) {
      return this.items();
    }
    if (!this.loading) {
      this.loading = firstValueFrom(this.api.get<OpenAlbionItem[]>('api/openalbion/catalog'))
        .then((items) => {
          const normalizedItems = items.map((item) => ({
            ...item,
            name: item.identifier
              ? normalizeAlbionEquipmentName(item.identifier, item.name)
              : item.name,
          }));
          this.items.set(normalizedItems);
          this.loaded.set(true);
          return normalizedItems;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }
}
