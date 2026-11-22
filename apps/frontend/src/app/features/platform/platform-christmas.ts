import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ChristmasSettings, intensities, presets } from '../../layout/christmas-settings';

@Component({
  selector: 'app-platform-christmas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card grid gap-3 p-4" aria-labelledby="christmas-title">
      <h2 id="christmas-title" class="section-title">Addobbi natalizi</h2>
      <p class="hint">Impostazioni predefinite per tutto il gestionale. Ogni persona può modificarle nel proprio browser.</p>
      @if (settings.defaults(); as defaults) {
        <form (submit)="save($event, enabled.checked, +preset.value, +intensity.value)">
          <fieldset class="grid gap-3" [disabled]="saving()">
            <label><input #enabled type="checkbox" [checked]="defaults.enabled" /> Abilita per tutta la piattaforma</label>
            <label>Preset
              <select #preset class="input">
                @for (item of presets; track item.name; let i = $index) {
                  <option [value]="i + 1" [selected]="defaults.preset === i + 1">{{ item.name }}</option>
                }
              </select>
            </label>
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
  protected readonly saving = signal(false);
  protected readonly message = signal('');

  protected async save(event: Event, enabled: boolean, preset: number, intensity: number) {
    event.preventDefault();
    this.saving.set(true);
    this.message.set('');
    try {
      await this.settings.save({ enabled, preset, intensity });
      this.message.set('Impostazioni salvate.');
    } catch {
      this.message.set('Salvataggio non riuscito. Riprova.');
    } finally {
      this.saving.set(false);
    }
  }
}
