import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ChristmasSettings, intensities, ornamentKeys, ornaments, presets } from './christmas-settings';

const messages = ['Una cioccolata prima della ZvZ.', 'Ringrazia il tuo caller.',
  'Il miglior bottino è una serata con la gilda.', 'Un brindisi a chi porta le pozioni.'];

function decemberDay() {
  const today = new Date();
  return today.getMonth() === 11 ? today.getDate() : 0;
}

@Component({
  selector: 'app-christmas-decorations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './christmas-decorations.css',
  template: `
    @if (settings.defaults()?.enabled) {
      <div class="scene" aria-hidden="true" [style.--strength]="strength()" [class.paused]="paused()">
        @for (layer of settings.active(); track layer) {
          <div class="layer" [class]="layer">
            @switch (layer) {
              @case ('snow') {
                @for (dot of particles(); track dot.i) {
                  <i [style.left.%]="dot.x" [style.--y]="dot.y + '%'" [style.--size]="dot.size + 'px'"
                    [style.animation-delay.s]="dot.delay" [style.animation-duration.s]="dot.duration"></i>
                }
              }
              @case ('embers') {
                @for (dot of particles(); track dot.i) {
                  <i [style.left.%]="dot.x" [style.--y]="dot.y + '%'" [style.--size]="dot.size + 'px'"
                    [style.animation-delay.s]="dot.delay" [style.animation-duration.s]="dot.duration"></i>
                }
              }
              @case ('lights') {
                @for (bulb of bulbs; track bulb) {
                  <i [style.animation-delay.s]="-bulb / 5"></i>
                }
              }
              @case ('aurora') { <i></i><i></i> }
              @case ('frost') {
                <svg viewBox="0 0 150 140">
                  <path d="M0 0 82 79m-62-60 28 1m-14 13 1 31m14-17 29 1M0 0l20 113m-12-65 24 22M0 0l125 30m-70-16 20 25"/>
                </svg>
              }
              @case ('village') {
                <svg viewBox="0 0 480 76" preserveAspectRatio="xMaxYMax meet">
                  <path fill="#424364" d="M0 76 60 44 124 63 190 32 245 53 316 24 382 50 424 29 480 50V76Z"/>
                  <path fill="#f4e5bb" d="M396 5a12 12 0 1 0 0 24 12 12 0 0 0 0-24Z"/>
                  @for (house of houses; track house) {
                    <g [attr.transform]="'translate(' + house + ' 32)'">
                      <path fill="#393049" d="M0 18 17 2 34 18h-4v23H4V18Z"/>
                      <path fill="#eeeaf8" d="M0 18 17 2 34 18h-5L17 8 5 18Z"/>
                      <path class="windows" fill="#ffc978" d="M9 21h6v8H9zm11 0h6v8h-6z"/>
                    </g>
                  }
                  <path fill="#bfc8dd" d="M0 76Q76 64 155 71T300 70 480 68V76Z"/>
                </svg>
              }
              @case ('sleigh') { <span>🦌 🦌 🛷</span> }
            }
          </div>
        }
      </div>
      <details class="controls">
        <summary class="btn btn--secondary btn--sm">❄ Addobbi</summary>
        <div class="panel card grid gap-3 p-3">
          <label><input #off type="checkbox" [checked]="settings.off()" (change)="settings.setOff(off.checked)" /> Disattiva tutti gli addobbi su questo browser</label>
          <fieldset class="grid gap-2" [disabled]="settings.off()">
            <legend>Personalizza gli addobbi</legend>
            <label>Preset
              <select #preset class="input" (change)="settings.setPreset(+preset.value); preset.value = ''">
                <option value="" selected>Scegli un preset…</option>
                @for (item of presets; track item.name; let i = $index) {
                  <option [value]="i + 1">{{ item.name }}</option>
                }
              </select>
            </label>
            <label>Intensità
              <select #intensity class="input" (change)="settings.setIntensity(+intensity.value)">
                @for (name of intensities; track name; let i = $index) {
                  <option [value]="i + 1" [selected]="settings.intensity() === i + 1">{{ name }}</option>
                }
              </select>
            </label>
            <div class="options">
              @for (key of keys; track key) {
                <label><input #layer type="checkbox" [checked]="settings.selected().includes(key)" (change)="settings.setLayer(key, layer.checked)" /> {{ ornaments[key] }}</label>
              }
            </div>
          </fieldset>
          @if (settings.active().length) {
            <button class="btn btn--secondary btn--sm" type="button" (click)="paused.set(!paused())">
              {{ paused() ? 'Riprendi animazioni' : 'Metti in pausa le animazioni' }}
            </button>
          }
          <button class="btn btn--secondary btn--sm" type="button" (click)="settings.reset()">Ripristina predefiniti</button>
          @if (settings.active().includes('advent')) {
            <details>
              <summary>Calendario dell’Avvento</summary>
              <div class="doors">
                @for (day of days; track day) {
                  <button type="button" class="btn btn--secondary btn--sm" [disabled]="day > availableDay"
                    [attr.aria-label]="'Giorno ' + day" (click)="open(day)">{{ day }}</button>
                }
              </div>
              <p role="status">{{ doorMessage() }}</p>
            </details>
          }
        </div>
      </details>
    }
  `,
})
export class ChristmasDecorations {
  protected readonly settings = inject(ChristmasSettings);
  protected readonly paused = signal(false);
  protected readonly presets = presets;
  protected readonly keys = ornamentKeys;
  protected readonly ornaments = ornaments;
  protected readonly intensities = intensities;
  protected readonly bulbs = Array.from({ length: 36 }, (_, i) => i);
  protected readonly houses = [32, 98, 163, 230, 288, 344, 420];
  protected readonly days = Array.from({ length: 24 }, (_, i) => i + 1);
  protected readonly availableDay = decemberDay();
  protected readonly doorMessage = signal(this.availableDay ? '' : 'Gli sportelli si aprono dal 1° dicembre.');
  protected readonly strength = computed(() => this.settings.intensity() * 0.25 + 0.2);
  protected readonly particles = computed(() =>
    Array.from({ length: 14 * this.settings.intensity() }, (_, i) => ({
      i, x: (67 * i + 13) % 100, y: (43 * i) % 100, size: 2 + i % 4,
      delay: -i * 1.31, duration: 8 + i % 11,
    })),
  );
  protected open(day: number) {
    this.doorMessage.set(`Giorno ${day} · ${messages[(day - 1) % messages.length]}`);
  }
}
