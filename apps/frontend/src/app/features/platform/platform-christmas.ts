import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  ChristmasSettings, defaultLayers, intensities, ornamentKeys, ornaments, presets,
  type ChristmasDefaults,
} from '../../layout/christmas-settings';

@Component({
  selector: 'app-platform-christmas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card grid gap-3 p-4" aria-labelledby="christmas-title">
      <h2 id="christmas-title" class="section-title">Addobbi natalizi</h2>
      <p class="hint">Impostazioni predefinite per tutto il gestionale. Ogni persona può modificarle nel proprio browser.</p>
      @if (settings.defaults(); as defaults) {
        <form (submit)="save($event, enabled.checked, +preset.value, +intensity.value, defaults)">
          <fieldset class="grid gap-3" [disabled]="saving()">
            <label><input #enabled type="checkbox" [checked]="defaults.enabled" /> Abilita per tutta la piattaforma</label>
            <label>Preset
              <select #preset class="input" (change)="draft.set({ preset: +preset.value, layers: null })">
                @for (item of presets; track item.name; let i = $index) {
                  <option [value]="i + 1" [selected]="defaults.preset === i + 1">{{ item.name }}</option>
                }
              </select>
            </label>
            <fieldset class="grid gap-2">
              <legend>Addobbi da combinare</legend>
              <p class="hint">Parti da un preset e seleziona tutti gli addobbi che vuoi.</p>
              <div class="flex flex-wrap gap-3">
                @for (key of keys; track key; let i = $index) {
                  <label>
                    <input #layer type="checkbox" [checked]="defaultLayers(config(defaults)).includes(key)"
                      (change)="toggle(defaults, i, layer.checked)" />
                    {{ ornaments[key] }}
                  </label>
                }
              </div>
            </fieldset>
            <label>Intensità predefinita
              <select #intensity class="input">
                @for (name of intensities; track name; let i = $index) {
                  <option [value]="i + 1" [selected]="defaults.intensity === i + 1">{{ name }}</option>
                }
              </select>
            </label>
            <div><button class="btn btn--primary" type="submit">Salva addobbi</button></div>
          </fieldset>
        </form>
        <p role="status">{{ message() }}</p>
      } @else if (settings.failed()) {
        <p role="status">Impossibile caricare le impostazioni natalizie.</p>
        <button class="btn" type="button" (click)="settings.load()">Riprova</button>
      } @else {
        <p role="status">Caricamento…</p>
      }
    </section>
  `,
})
export class PlatformChristmas {
  protected readonly settings = inject(ChristmasSettings);
  protected readonly presets = presets;
  protected readonly intensities = intensities;
  protected readonly keys = ornamentKeys;
  protected readonly ornaments = ornaments;
  protected readonly defaultLayers = defaultLayers;
  protected readonly draft = signal<Pick<ChristmasDefaults, 'preset' | 'layers'> | null>(null);
  protected readonly saving = signal(false);
  protected readonly message = signal('');

  protected config(defaults: ChristmasDefaults): ChristmasDefaults {
    return { ...defaults, ...this.draft() };
  }

  protected toggle(defaults: ChristmasDefaults, index: number, checked: boolean) {
    const config = this.config(defaults);
    const selected = defaultLayers(config);
    const mask = ornamentKeys.reduce((value, key, i) =>
      selected.includes(key) ? value | (1 << i) : value, 0);
    const bit = 1 << index;
    this.draft.set({ preset: config.preset, layers: checked ? mask | bit : mask & ~bit });
  }

  protected async save(event: Event, enabled: boolean, preset: number, intensity: number, defaults: ChristmasDefaults) {
    event.preventDefault();
    this.saving.set(true);
    this.message.set('');
    try {
      await this.settings.save({ enabled, preset, intensity, layers: this.config(defaults).layers });
      this.draft.set(null);
      this.message.set('Impostazioni salvate.');
    } catch {
      this.message.set('Salvataggio non riuscito. Riprova.');
    } finally {
      this.saving.set(false);
    }
  }
}
