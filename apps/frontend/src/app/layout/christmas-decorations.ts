import {
  ChangeDetectionStrategy, Component, OnDestroy, ViewEncapsulation, afterNextRender,
  effect, inject, signal,
} from '@angular/core';
import { NgZone } from '@angular/core';

import { Icon } from '../shared/components/icon/icon';
import { ChristmasEngine } from './christmas-engine';
import { ChristmasSettings, intensities, ornamentKeys, ornaments, presets } from './christmas-settings';

const NOTES: readonly string[] = [
  'il regear più bello è quello che non serve.',
  'un brindisi a chi porta le pozioni per tutti.',
  'oggi conta i compagni, non il silver.',
  'il miglior loot dell’anno è la gilda al completo in Discord.',
  'missione del giorno: ringrazia il tuo caller.',
  'anche il tank ha bisogno di un abbraccio.',
  'una cioccolata calda prima della ZvZ.',
  'il mammut da trasporto ti augura buone feste.',
  'niente gank oggi, solo pupazzi di neve a Martlock.',
  'chi ripara le armature ripara anche l’umore.',
  'la banca è in attivo di buonumore.',
  'controlla di avere ancora scorte di cibo per le feste.',
  'un fiocco di neve vale un punto stile.',
  'scrivi a chi non vedi in gioco da un po’.',
  'fame di fama? Prima una fetta di panettone.',
  'gli scout segnalano renne sulle Strade di Avalon.',
  'ogni split equo è un piccolo regalo.',
  'tieni il silver al caldo, fuori fa freddo.',
  'la neve copre tutto, tranne le kill in bacheca.',
  'mancano quattro sportelli: tieni duro.',
  'il solstizio è la notte più lunga, perfetta per un’ultima uscita.',
  'prepara il set più elegante per la foto di gilda.',
  'domani si festeggia: lascia libero il calendario.',
  'buon Natale. Grazie di esserci.',
];

/** Day of December, or 0 outside December: future doors then stay shut. */
function todayInAdvent(): number {
  const now = new Date();
  return now.getMonth() === 11 ? now.getDate() : 0;
}

/** Shuffled door order, the same for everyone and on every visit. */
function doorOrder(): number[] {
  const order = Array.from({ length: 24 }, (_, i) => i + 1);
  let seed = 24;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const adventStorageKey = 'wm:christmas:advent';

/**
 * One-line holiday greeting above the page, with a per-browser close button.
 */
@Component({
  selector: 'app-christmas-greetings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="card fx-greetings" aria-labelledby="fx-greetings-title">
      <span class="fx-greetings__icon" aria-hidden="true"><app-icon name="sparkles" size="1.25rem" /></span>
      <div class="min-w-0 flex-1">
        <h2 id="fx-greetings-title" class="section-title section-title--sm">Buone feste!</h2>
        <p class="hint">Gli addobbi di Natale sono accesi. Puoi cambiarli o spegnerli per il tuo browser dal pulsante “❄ Addobbi” in basso a destra.</p>
      </div>
      <button type="button" class="btn btn--ghost" aria-label="Chiudi gli auguri" (click)="settings.dismissGreetings()">✕</button>
    </section>
  `,
})
export class ChristmasGreetings {
  protected readonly settings = inject(ChristmasSettings);
}

/**
 * Draws the Christmas decorations over the whole application and offers the
 * per-browser controls. The layers themselves live in `ChristmasEngine`.
 */
@Component({
  selector: 'app-christmas-decorations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The layers style elements outside this component (cards, top bar, body).
  encapsulation: ViewEncapsulation.None,
  styleUrl: './christmas-decorations.css',
  template: `
    @if (settings.defaults()?.enabled) {
      <details class="xmas-controls">
        <summary class="btn btn--tonal">❄ Addobbi</summary>
        <div class="xmas-panel card">
          <p class="hint">Queste preferenze valgono solo per questo browser.</p>
          <label class="xmas-check">
            <input #off type="checkbox" [checked]="settings.off()" (change)="settings.setOff(off.checked)" />
            Disattiva tutti gli addobbi su questo browser
          </label>
          <fieldset class="xmas-group" [disabled]="settings.off()">
            <legend>Personalizza gli addobbi</legend>
            <label class="xmas-field">Preset
              <select #preset class="select" (change)="settings.setPreset(+preset.value); preset.value = ''">
                <option value="" selected>Scegli un preset…</option>
                @for (item of presets; track item.name; let i = $index) {
                  <option [value]="i + 1">{{ item.name }}</option>
                }
              </select>
            </label>
            <label class="xmas-field">Intensità
              <select #intensity class="select" (change)="settings.setIntensity(+intensity.value)">
                @for (name of intensities; track name; let i = $index) {
                  <option [value]="i + 1" [selected]="settings.intensity() === i + 1">{{ name }}</option>
                }
              </select>
            </label>
            <p class="hint">Puoi accendere più addobbi insieme.</p>
            <div class="xmas-options">
              @for (key of keys; track key) {
                <label class="xmas-check">
                  <input #layer type="checkbox" [checked]="settings.selected().includes(key)"
                    (change)="settings.setLayer(key, layer.checked)" />
                  {{ ornaments[key] }}
                </label>
              }
            </div>
          </fieldset>
          <div class="xmas-actions">
            @if (settings.active().length) {
              <button class="btn btn--outline" type="button" (click)="paused.set(!paused())">
                {{ paused() ? 'Riprendi animazioni' : 'Metti in pausa' }}
              </button>
            }
            @if (settings.active().includes('sleigh') && !paused()) {
              <button class="btn btn--outline" type="button" (click)="fly()">Chiama la slitta</button>
            }
            <button class="btn btn--outline" type="button" (click)="settings.reset()">Ripristina predefiniti</button>
          </div>
          @if (reducedMotion && !paused()) {
            <p class="hint">Il tuo sistema chiede di ridurre il movimento: le animazioni sono in pausa.</p>
          }
          @if (settings.active().includes('advent')) {
            <section class="xmas-advent" aria-labelledby="xmas-advent-title">
              <h2 id="xmas-advent-title" class="section-title section-title--sm">Calendario dell’Avvento</h2>
              <div class="xmas-doors">
                @for (day of order; track day) {
                  <button type="button" class="xmas-door"
                    [class.is-open]="opened().includes(day)" [class.is-today]="day === today"
                    [disabled]="day > today" [attr.aria-label]="doorLabel(day)" (click)="open(day)">
                    <span aria-hidden="true">{{ opened().includes(day) ? '✦' : day }}</span>
                  </button>
                }
              </div>
              <p role="status">{{ doorMessage() }}</p>
            </section>
          }
        </div>
      </details>
    }
  `,
})
export class ChristmasDecorations implements OnDestroy {
  protected readonly settings = inject(ChristmasSettings);
  protected readonly keys = ornamentKeys;
  protected readonly ornaments = ornaments;
  protected readonly presets = presets;
  protected readonly intensities = intensities;
  /** Starts frozen when the operating system asks for less motion. */
  protected readonly reducedMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  protected readonly paused = signal(this.reducedMotion);
  protected readonly order = doorOrder();
  protected readonly today = todayInAdvent();
  protected readonly opened = signal<readonly number[]>(this.readOpened());
  protected readonly doorMessage = signal(
    this.today ? 'Apri lo sportello di oggi, quello con il bordo dorato.' : 'Gli sportelli si aprono dal 1° dicembre.',
  );

  private readonly zone = inject(NgZone);
  private engine: ChristmasEngine | null = null;

  constructor() {
    effect(() => this.sync());
    afterNextRender(() => {
      this.zone.runOutsideAngular(() => {
        this.engine = new ChristmasEngine();
        this.sync();
      });
    });
  }

  ngOnDestroy(): void {
    this.zone.runOutsideAngular(() => this.engine?.destroy());
    this.engine = null;
  }

  protected fly(): void {
    this.engine?.flySleigh();
  }

  protected doorLabel(day: number): string {
    if (day > this.today) return `Giorno ${day}, si apre il ${day} dicembre`;
    return this.opened().includes(day) ? `Giorno ${day}, aperto` : `Apri il giorno ${day}`;
  }

  protected open(day: number): void {
    if (day > this.today) {
      this.doorMessage.set(`Lo sportello ${day} si apre il ${day} dicembre.`);
      return;
    }
    const note = NOTES[day - 1] ?? '';
    this.doorMessage.set(`${day} dicembre · ${note.charAt(0).toUpperCase()}${note.slice(1)}`);
    if (this.opened().includes(day)) return;
    const next = [...this.opened(), day];
    this.opened.set(next);
    try { localStorage.setItem(adventStorageKey, JSON.stringify(next)); } catch { /* Keep it for this visit. */ }
  }

  private readOpened(): readonly number[] {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(adventStorageKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter((d): d is number => typeof d === 'number') : [];
    } catch {
      return [];
    }
  }

  /**
   * Mirrors the settings into the scene layers. The signals are read before the
   * engine check on purpose: `engine?.sync({...})` would skip the reads while the
   * engine is still null, leaving the effect with no dependencies to rerun on.
   */
  private sync(): void {
    const state = {
      active: this.settings.active(),
      intensity: this.settings.intensity(),
      paused: this.paused(),
    };
    this.engine?.sync(state);
  }
}
