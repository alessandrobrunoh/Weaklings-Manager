import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { OpenAlbionItem } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { normalizeAlbionEquipmentName } from '../data/albion-equipment-catalog';

@Injectable({ providedIn: 'root' })
export class AlbionCatalogService {
  private readonly api = inject(ApiService);
  private readonly items = signal<OpenAlbionItem[]>([]);
  private loading: Promise<readonly OpenAlbionItem[]> | null = null;

  async load(): Promise<readonly OpenAlbionItem[]> {
    if (this.items().length > 0) {
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
          return normalizedItems;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }
}
