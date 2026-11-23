import { afterNextRender, computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../core/services/api.service';

export const ornaments = {
  snow: 'Neve', caps: 'Neve sui pannelli', lights: 'Luminarie', aurora: 'Aurora',
  stars: 'Stelle', advent: 'Avvento', village: 'Villaggio', garland: 'Ghirlanda',
  frost: 'Brina', embers: 'Braci', sleigh: 'Slitta', theme: 'Dettagli festivi',
} as const;
export type Ornament = keyof typeof ornaments;
// Persisted bit positions: append new layers, never reorder existing ones.
export const ornamentKeys = [
  'snow', 'caps', 'lights', 'aurora', 'stars', 'advent', 'village', 'garland',
  'frost', 'embers', 'sleigh', 'theme',
] as const satisfies readonly Ornament[];
export const presets: readonly { name: string; layers: readonly Ornament[] }[] = [
  { name: 'Nevicata', layers: ['snow', 'caps'] },
  { name: 'Luminarie', layers: ['lights'] },
  { name: 'Aurora polare', layers: ['aurora', 'stars'] },
  { name: 'Calendario dell’Avvento', layers: ['advent'] },
  { name: 'Villaggio di mezzanotte', layers: ['village'] },
  { name: 'Ghirlanda', layers: ['garland'] },
  { name: 'Brina', layers: ['frost'] },
  { name: 'Braci del camino', layers: ['embers'] },
  { name: 'Notte stellata', layers: ['stars', 'sleigh'] },
  { name: 'Dettagli festivi', layers: ['theme'] },
  { name: 'Natale classico', layers: ['snow', 'caps', 'lights', 'theme'] },
  { name: 'Notte nordica', layers: ['aurora', 'stars', 'village', 'snow'] },
  { name: 'Baita in montagna', layers: ['village', 'embers', 'garland', 'frost'] },
  { name: 'Bottega di Babbo Natale', layers: ['garland', 'theme', 'advent', 'sleigh'] },
];
export const intensities = ['Leggera', 'Media', 'Piena'];
export interface ChristmasDefaults { enabled: boolean; preset: number; intensity: number; layers: number | null }

export function defaultLayers(defaults: ChristmasDefaults): readonly Ornament[] {
  const mask = defaults.layers;
  return mask == null ? presets[defaults.preset - 1]?.layers ?? [] :
    ornamentKeys.filter((_, index) => (mask & (1 << index)) !== 0);
}
interface BrowserDecorations {
  off?: boolean;
  layers?: Ornament[];
  intensity?: number;
  /** The greetings banner was closed on this browser. */
  greetings?: boolean;
}

const storageKey = 'wm:christmas';
const endpoint = 'api/platform/christmas';

@Injectable({ providedIn: 'root' })
export class ChristmasSettings {
  private readonly api = inject(ApiService);
  private readonly platform = signal<ChristmasDefaults | null>(null);
  private readonly browser = signal<BrowserDecorations>({});
  readonly defaults = this.platform.asReadonly();
  readonly failed = signal(false);
  readonly off = computed(() => this.browser().off ?? false);
  readonly greetingsDismissed = computed(() => this.browser().greetings === true);
  readonly selected = computed(() => {
    const defaults = this.platform();
    return this.browser().layers ?? (defaults ? defaultLayers(defaults) : []);
  });
  readonly intensity = computed(() => this.browser().intensity ?? this.platform()?.intensity ?? 1);
  readonly active = computed(() => this.platform()?.enabled && !this.off() ? this.selected() : []);

  constructor() {
    afterNextRender(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        if (saved && typeof saved === 'object') {
          this.browser.set({
            off: saved.off === true,
            layers: Array.isArray(saved.layers) ? ornamentKeys.filter((key) => saved.layers.includes(key)) : undefined,
            intensity: [1, 2, 3].includes(saved.intensity) ? saved.intensity : undefined,
            greetings: saved.greetings === true ? true : undefined,
          });
        }
      } catch { /* Browser storage can be unavailable. */ }
      void this.load();
    });
  }

  async load() {
    this.failed.set(false);
    try {
      this.platform.set(await firstValueFrom(this.api.get<ChristmasDefaults>(endpoint)));
    } catch {
      this.failed.set(true);
    }
  }

  async save(defaults: ChristmasDefaults) {
    this.platform.set(await firstValueFrom(this.api.put<ChristmasDefaults>(endpoint, defaults)));
  }

  setOff(off: boolean) { this.persist({ ...this.browser(), off }); }
  setIntensity(intensity: number) { this.persist({ ...this.browser(), intensity }); }
  setPreset(preset: number) {
    const item = presets[preset - 1];
    if (item) this.persist({ ...this.browser(), layers: [...item.layers] });
  }
  setLayer(key: Ornament, enabled: boolean) {
    const layers = new Set(this.selected());
    if (enabled) layers.add(key);
    else layers.delete(key);
    this.persist({ ...this.browser(), layers: [...layers] });
  }
  reset() { this.persist({}); }
  dismissGreetings() { this.persist({ ...this.browser(), greetings: true }); }

  private persist(value: BrowserDecorations) {
    this.browser.set(value);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Keep in-memory preference. */ }
  }
}
