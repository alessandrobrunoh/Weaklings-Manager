import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type {
  ScenarioDefinition,
  ScenarioResult,
  ScenarioUnitOutcome,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { albionAbilityIconUrl } from '../../../shared/data/albion-abilities';
import { Icon } from '../../../shared/components/icon/icon';
import {
  CLIP_GAP,
  CLIP_HEIGHT,
  DEFAULT_ZOOM_INDEX,
  LANE_BASE_HEIGHT,
  MAX_VISIBLE_SUBROWS,
  SUBROW_HEIGHT,
  type TimelineClip,
  type TimelineLane,
  ZOOM_LEVELS,
  buildLanes,
  hpSegmentsFor,
  laneIndexAtY,
  logsTargeting,
  matchLandTimes,
  neverTargetedUnitIds,
  orphanClips,
  parseCooldownSeconds,
  secondsToX,
  snapSeconds,
  tickMarks,
  timelineDuration,
  unitOutcomeIndex,
  xToSeconds,
} from './scenario-timeline';

/** Where the editor would place the thing currently being dragged. */
interface DropPreview {
  readonly laneIndex: number;
  readonly seconds: number;
}

/** A clip being dragged with the pointer. */
interface PointerDrag {
  readonly pointerId: number;
  readonly castIndex: number;
  readonly startX: number;
  readonly startY: number;
  /** Distance from the clip's left edge to the cursor, so the clip does not jump on grab. */
  readonly grabOffset: number;
  moved: boolean;
}

/** One unit instance's row under an expanded lane. */
interface SubRow {
  readonly unitId: string;
  readonly outcome: ScenarioUnitOutcome | null;
  readonly segments: readonly { x: number; width: number; heightPercent: number; tone: string }[];
  readonly diedAtX: number | null;
  readonly replayMismatch: boolean;
  readonly targetMarks: readonly { x: number; healing: boolean }[];
}

/** How far the pointer must travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** Pixels within which a dragged clip snaps onto another cast's exact time. */
const MAGNET_PX = 6;

/**
 * The cast timeline as a timeline: seconds along the x-axis, one lane per unit group, each cast a
 * clip you can drag.
 *
 * Presentational — it holds only view state (zoom, which lanes are expanded, an in-flight drag) and
 * emits the edit it would like made. Every number it renders comes from `scenario-timeline.ts`, so
 * the first server-rendered paint needs no DOM measurement.
 */
@Component({
  selector: 'app-timeline-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    '(document:pointermove)': 'onPointerMove($event)',
    '(document:pointerup)': 'onPointerUp($event)',
    '(document:pointercancel)': 'cancelDrag()',
  },
  template: `
    <div class="grid gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-[11px] text-[var(--color-text-tertiary)]">{{ t('tests.timeline.snapHint') }}</p>
        <div class="flex items-center gap-2">
          @if (result()) {
            <label class="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                [checked]="showResults()"
                (change)="showResults.set($any($event.target).checked)"
              />
              {{ t('tests.timeline.showResults') }}
            </label>
          }
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            [attr.aria-label]="t('tests.timeline.zoomOut')"
            [disabled]="zoomIndex() === 0"
            (click)="zoomBy(-1)"
          >
            −
          </button>
          <span class="mono text-[11px] text-[var(--color-text-tertiary)]">
            {{ t('tests.timeline.zoomLevel', { value: pxPerSecond() }) }}
          </span>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            [attr.aria-label]="t('tests.timeline.zoomIn')"
            [disabled]="zoomIndex() === maxZoomIndex"
            (click)="zoomBy(1)"
          >
            +
          </button>
        </div>
      </div>

      @if (staleResult()) {
        <div class="chip chip--warning flex w-fit items-center gap-2 text-xs">
          {{ t('tests.timeline.staleRun') }}
          <button type="button" class="btn btn--ghost btn--sm" (click)="runRequested.emit()">
            {{ t('tests.runNow') }}
          </button>
        </div>
      }

      @if (warnings().length > 0) {
        <ul class="grid gap-1" role="list">
          @for (warning of warnings(); track $index) {
            <li class="text-xs text-[var(--color-warning)]">{{ warning }}</li>
          }
        </ul>
      }

      @if (lanes().length === 0 && orphans().length === 0) {
        <p class="text-xs text-[var(--color-text-secondary)]">{{ t('tests.timeline.noLanes') }}</p>
      } @else {
        <p id="timeline-instructions" class="sr-only">{{ t('tests.timeline.instructions') }}</p>
        <div
          class="timeline-scroller"
          tabindex="0"
          role="group"
          aria-describedby="timeline-instructions"
          [attr.aria-label]="t('tests.timeline.regionLabel')"
        >
          <div class="timeline-rows">
            <div class="timeline-row timeline-ruler">
              <div class="timeline-gutter"></div>
              <div class="timeline-track" aria-hidden="true" [style.width.px]="trackWidth()">
                @for (tick of ticks(); track tick.seconds) {
                  <span
                    class="tick"
                    [class.tick--major]="tick.major"
                    [style.left.px]="x(tick.seconds)"
                  >
                    @if (tick.major) {
                      <span class="tick__label">{{ tick.seconds }}s</span>
                    }
                  </span>
                }
              </div>
            </div>

            <div #lanesContainer>
            @for (lane of lanes(); track lane.index) {
              <div
                class="timeline-row"
                role="group"
                [attr.data-lane-index]="lane.index"
                [attr.aria-label]="laneLabel(lane)"
                [style.height.px]="laneRowHeight(lane)"
              >
                <div class="timeline-gutter" [class.timeline-gutter--enemy]="lane.group.side === 'enemy'">
                  <button
                    type="button"
                    class="lane-toggle"
                    [attr.aria-expanded]="isExpanded(lane)"
                    [attr.aria-label]="
                      isExpanded(lane)
                        ? t('tests.timeline.collapseLane', { label: lane.group.label })
                        : t('tests.timeline.expandLane', { label: lane.group.label })
                    "
                    (click)="toggleLane(lane)"
                  >
                    <app-icon [name]="isExpanded(lane) ? 'chevron-down' : 'chevron-right'" size="0.75rem" />
                  </button>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs font-semibold">{{ lane.group.label }}</span>
                    <span class="block truncate text-[10px] text-[var(--color-text-tertiary)]">
                      {{ lane.group.side === 'enemy' ? t('tests.enemy') : t('tests.ally') }}
                      · {{ lane.unitIds.length }}
                      @if (duplicateGroupIds().has(lane.group.id)) {
                        · {{ t('tests.timeline.duplicateGroupId') }}
                      }
                    </span>
                  </span>
                </div>

                <div
                  class="timeline-track timeline-track--lane"
                  data-track
                  [class.timeline-track--drop]="dropPreview()?.laneIndex === lane.index"
                  [style.width.px]="trackWidth()"
                  (dragover)="onDragOver($event, lane.index)"
                  (dragleave)="onDragLeave($event)"
                  (drop)="onDrop($event, lane.index)"
                >
                  @for (clip of lane.clips; track clip.castIndex) {
                    <button
                      type="button"
                      class="clip"
                      [class.clip--selected]="clip.castIndex === selectedCastIndex()"
                      [class.clip--foreign]="isForeign(clip)"
                      [class.clip--unknown]="isUnknown(clip)"
                      [attr.aria-pressed]="clip.castIndex === selectedCastIndex()"
                      [attr.aria-label]="clipLabel(clip)"
                      [attr.data-cast-index]="clip.castIndex"
                      [style.transform]="'translateX(' + clipX(clip) + 'px)'"
                      [style.top.px]="clip.row * (clipHeight + clipGap) + 4"
                      (pointerdown)="onPointerDown($event, clip)"
                      (click)="onClipClick($event, clip)"
                      (keydown)="onClipKeydown($event, clip)"
                    >
                      @if (cooldownWidth(clip); as width) {
                        <span class="clip__cooldown" aria-hidden="true" [style.width.px]="width"></span>
                      }
                      <img
                        class="clip__icon"
                        alt=""
                        [src]="iconFor(clip.cast.spell_id)"
                        (error)="onIconError($event)"
                      />
                      @if (clip.cast.target_ids.length === 0) {
                        <span class="clip__badge" aria-hidden="true">!</span>
                      }
                    </button>
                  }

                  @if (dropPreview(); as preview) {
                    @if (preview.laneIndex === lane.index) {
                      <span
                        class="clip clip--ghost"
                        aria-hidden="true"
                        [style.transform]="'translateX(' + x(preview.seconds) + 'px)'"
                      ></span>
                    }
                  }
                </div>
              </div>

              @if (isExpanded(lane)) {
                <div class="timeline-row timeline-row--sub" [style.height.px]="subRowsHeight(lane)">
                  <div class="timeline-gutter timeline-gutter--sub"></div>
                  <div class="timeline-track" [style.width.px]="trackWidth()">
                    <ul class="subrows" role="list" [style.height.px]="subRowsHeight(lane)">
                      @for (row of subRowsFor(lane); track row.unitId) {
                        <li class="subrow">
                          <span class="subrow__id">{{ row.unitId }}</span>
                          @for (segment of row.segments; track $index) {
                            <span
                              class="subrow__hp"
                              [style.left.px]="segment.x"
                              [style.width.px]="segment.width"
                              [style.height.%]="segment.heightPercent"
                              [style.background-color]="segment.tone"
                            ></span>
                          }
                          @for (mark of row.targetMarks; track $index) {
                            <span
                              class="subrow__mark"
                              [class.subrow__mark--heal]="mark.healing"
                              [style.left.px]="mark.x"
                              aria-hidden="true"
                            >{{ mark.healing ? '▲' : '▼' }}</span>
                          }
                          @if (row.diedAtX !== null) {
                            <span
                              class="subrow__death"
                              [style.left.px]="row.diedAtX"
                              [attr.aria-label]="
                                t('tests.timeline.diedAt', { at: secondsLabel(row.outcome!.died_at!) })
                              "
                            >✕</span>
                          }
                          @if (row.replayMismatch) {
                            <span class="subrow__note">{{ t('tests.timeline.hpReplayMismatch') }}</span>
                          }
                        </li>
                      }
                    </ul>
                  </div>
                </div>
              }
            }

            @if (orphans().length > 0) {
              <div
                class="timeline-row"
                role="group"
                [attr.data-lane-index]="-1"
                [attr.aria-label]="t('tests.timeline.orphanLane')"
                [style.height.px]="laneBaseHeight + orphanRows() * (clipHeight + clipGap)"
              >
                <div class="timeline-gutter timeline-gutter--orphan">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs font-semibold">
                      {{ t('tests.timeline.orphanLane') }}
                    </span>
                    <span class="block truncate text-[10px] text-[var(--color-text-tertiary)]">
                      {{ t('tests.timeline.orphanHint') }}
                    </span>
                  </span>
                </div>
                <div
                  class="timeline-track timeline-track--lane"
                  data-track
                  [style.width.px]="trackWidth()"
                >
                  @for (clip of orphans(); track clip.castIndex) {
                    <button
                      type="button"
                      class="clip clip--foreign"
                      [class.clip--selected]="clip.castIndex === selectedCastIndex()"
                      [attr.aria-pressed]="clip.castIndex === selectedCastIndex()"
                      [attr.aria-label]="clipLabel(clip)"
                      [attr.data-cast-index]="clip.castIndex"
                      [style.transform]="'translateX(' + clipX(clip) + 'px)'"
                      [style.top.px]="clip.row * (clipHeight + clipGap) + 4"
                      (pointerdown)="onPointerDown($event, clip)"
                      (click)="onClipClick($event, clip)"
                      (keydown)="onClipKeydown($event, clip)"
                    >
                      <img
                        class="clip__icon"
                        alt=""
                        [src]="iconFor(clip.cast.spell_id)"
                        (error)="onIconError($event)"
                      />
                    </button>
                  }
                </div>
              </div>
            }
            </div>
          </div>
        </div>
      }

      <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
    </div>
  `,
  styles: `
    .timeline-scroller {
      overflow: auto;
      overscroll-behavior-x: contain;
      max-height: 32rem;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background-color: var(--color-surface);
      touch-action: pan-x pan-y;
    }
    .timeline-scroller:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .timeline-rows {
      width: max-content;
      min-width: 100%;
    }
    .timeline-row {
      display: flex;
      align-items: stretch;
      border-bottom: 1px solid var(--color-border);
    }
    .timeline-ruler {
      position: sticky;
      top: 0;
      z-index: 3;
      background-color: var(--color-surface);
      height: 1.75rem;
    }
    .timeline-gutter {
      position: sticky;
      left: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      width: 13rem;
      flex: none;
      border-right: 1px solid var(--color-border);
      border-left: 3px solid var(--color-info, var(--color-primary));
      background-color: var(--color-surface);
      padding: 0.25rem 0.5rem;
    }
    .timeline-gutter--enemy {
      border-left-color: var(--color-error);
    }
    .timeline-gutter--orphan {
      border-left-color: var(--color-warning);
    }
    .timeline-gutter--sub {
      border-left-color: transparent;
    }
    .timeline-track {
      position: relative;
      flex: none;
    }
    .timeline-track--drop {
      background-color: var(--color-primary-container);
    }
    .lane-toggle {
      display: inline-flex;
      height: 1.25rem;
      width: 1.25rem;
      flex: none;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      color: var(--color-text-secondary);
    }
    .lane-toggle:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 1px;
    }
    .tick {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background-color: var(--color-border);
    }
    .tick--major {
      background-color: var(--color-border-strong, var(--color-border));
    }
    .tick__label {
      position: absolute;
      top: 0.125rem;
      left: 0.25rem;
      font-size: 0.625rem;
      font-variant-numeric: tabular-nums;
      color: var(--color-text-tertiary);
      white-space: nowrap;
    }
    .clip {
      position: absolute;
      left: 0;
      display: flex;
      height: 30px;
      width: 44px;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--color-border-strong, var(--color-border));
      border-left: 2px solid var(--color-primary);
      border-radius: 4px;
      background-color: var(--color-surface-2, var(--color-surface));
      touch-action: none;
      cursor: grab;
    }
    .clip:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
      z-index: 1;
    }
    .clip--selected {
      border-color: var(--color-primary);
      box-shadow: 0 0 0 2px var(--color-primary-container);
    }
    .clip--selected::after {
      content: '✓';
      position: absolute;
      right: 1px;
      bottom: 0;
      font-size: 0.5rem;
      color: var(--color-primary);
    }
    .clip--foreign {
      border-style: dashed;
      border-color: var(--color-warning);
    }
    .clip--unknown {
      border-style: solid;
      border-color: var(--color-error);
    }
    .clip--ghost {
      pointer-events: none;
      border-style: dashed;
      opacity: 0.6;
      top: 4px;
    }
    .clip__icon {
      height: 1.25rem;
      width: 1.25rem;
    }
    .clip__badge {
      position: absolute;
      top: -2px;
      right: 1px;
      font-size: 0.625rem;
      font-weight: 700;
      color: var(--color-warning);
    }
    .clip__cooldown {
      position: absolute;
      left: 100%;
      top: 25%;
      height: 50%;
      pointer-events: none;
      background-image: repeating-linear-gradient(
        45deg,
        color-mix(in oklab, var(--color-text) 12%, transparent) 0 4px,
        transparent 4px 8px
      );
    }
    .subrows {
      display: grid;
      overflow-y: auto;
    }
    .subrow {
      position: relative;
      height: 26px;
      border-top: 1px dashed var(--color-border);
    }
    .subrow__id {
      position: sticky;
      left: 0.25rem;
      z-index: 1;
      font-family: var(--font-mono, monospace);
      font-size: 0.625rem;
      color: var(--color-text-tertiary);
    }
    .subrow__hp {
      position: absolute;
      bottom: 0;
      opacity: 0.55;
    }
    .subrow__mark {
      position: absolute;
      top: 0;
      font-size: 0.5rem;
      color: var(--color-error);
    }
    .subrow__mark--heal {
      color: var(--color-success);
    }
    .subrow__death {
      position: absolute;
      top: 0.125rem;
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--color-error);
    }
    .subrow__note {
      position: absolute;
      right: 0.5rem;
      top: 0.25rem;
      font-size: 0.625rem;
      color: var(--color-warning);
    }
    @media (prefers-reduced-motion: reduce) {
      .clip {
        transition: none;
      }
    }
  `,
})
export class TimelineEditor {
  private readonly translate = inject(TranslateService);
  private readonly lanesContainer = viewChild<ElementRef<HTMLElement>>('lanesContainer');

  readonly definition = input.required<ScenarioDefinition>();
  /** Every spell id each group's weapon offers, keyed by group id. */
  readonly knownSpellIdsByGroup = input<Record<string, ReadonlySet<string>>>({});
  /** Free-text cooldowns keyed by spell id, for the recharge shadow. */
  readonly cooldownsBySpell = input<Record<string, string | null | undefined>>({});
  readonly result = input<ScenarioResult | null>(null);
  /** The run predates the current draft, so its overlay is history rather than an answer. */
  readonly staleResult = input(false);
  readonly selectedCastIndex = input<number | null>(null);
  readonly canManage = input(false);

  readonly castCreated = output<{ casterGroupId: string; spellId: string; castAt: number }>();
  readonly castMoved = output<{ index: number; castAt: number; casterGroupId: string }>();
  readonly castRemoved = output<number>();
  readonly castSelected = output<number>();
  readonly runRequested = output<void>();

  protected readonly clipHeight = CLIP_HEIGHT;
  protected readonly clipGap = CLIP_GAP;
  protected readonly laneBaseHeight = LANE_BASE_HEIGHT;
  protected readonly maxZoomIndex = ZOOM_LEVELS.length - 1;

  protected readonly zoomIndex = signal(DEFAULT_ZOOM_INDEX);
  protected readonly showResults = signal(true);
  protected readonly expandedGroupIds = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly dropPreview = signal<DropPreview | null>(null);
  protected readonly announcement = signal('');

  /** The library drag in flight, so a `dragover` can preview it without reading `dataTransfer`. */
  private libraryDrag: { casterGroupId: string; spellId: string } | null = null;
  private pointerDrag: PointerDrag | null = null;

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly pxPerSecond = computed(() => ZOOM_LEVELS[this.zoomIndex()]);

  protected readonly visibleResult = computed(() => (this.showResults() ? this.result() : null));

  protected readonly duration = computed(() =>
    timelineDuration(this.definition(), this.visibleResult(), this.dropPreview()?.seconds ?? 0),
  );

  protected readonly trackWidth = computed(() => secondsToX(this.duration(), this.pxPerSecond()));

  protected readonly ticks = computed(() => tickMarks(this.duration(), this.pxPerSecond()));

  protected readonly lanes = computed(() => buildLanes(this.definition(), this.pxPerSecond()));

  protected readonly orphans = computed(() => orphanClips(this.definition(), this.pxPerSecond()));

  protected readonly orphanRows = computed(() =>
    this.orphans().reduce((max, clip) => Math.max(max, clip.row + 1), 1),
  );

  /** Group ids more than one group claims — the lanes a cast cannot be told apart between. */
  protected readonly duplicateGroupIds = computed(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const group of this.definition().groups) {
      if (seen.has(group.id)) duplicates.add(group.id);
      seen.add(group.id);
    }
    return duplicates;
  });

  private readonly landTimes = computed(() => {
    const run = this.visibleResult();
    return run ? matchLandTimes(this.definition(), run) : [];
  });

  private readonly outcomes = computed(() => {
    const run = this.visibleResult();
    return run ? unitOutcomeIndex(run) : new Map<string, ScenarioUnitOutcome>();
  });

  protected readonly warnings = computed<string[]>(() => {
    const out: string[] = [];
    const run = this.visibleResult();
    if (run) {
      if (run.unknown_spells.length > 0) {
        out.push(`${this.t('tests.unknownSpells')}: ${[...new Set(run.unknown_spells)].join(', ')}`);
      }
      if (run.casts_with_no_targets.length > 0) {
        out.push(
          `${this.t('tests.castsWithNoTargets')}: ${[...new Set(run.casts_with_no_targets)].join(', ')}`,
        );
      }
      if (this.landTimes().some((value) => value === null) && this.definition().casts.length > 0) {
        out.push(this.t('tests.timeline.landAtUnavailable'));
      }
    }
    const never = neverTargetedUnitIds(this.definition());
    if (never.length > 0) {
      const shown = never.slice(0, 5).join(', ');
      const rest = never.length - 5;
      out.push(
        this.t('tests.timeline.neverTargeted', {
          ids: rest > 0 ? `${shown} ${this.t('tests.timeline.andMore', { count: rest })}` : shown,
        }),
      );
    }
    return out;
  });

  private readonly unknownSpellIds = computed(
    () => new Set(this.visibleResult()?.unknown_spells ?? []),
  );

  // ---- Rendering helpers ----

  protected x(seconds: number): number {
    return secondsToX(seconds, this.pxPerSecond());
  }

  protected clipX(clip: TimelineClip): number {
    const drag = this.dropPreview();
    if (drag && this.pointerDrag?.castIndex === clip.castIndex) return this.x(drag.seconds);
    return clip.x;
  }

  protected iconFor(spellId: string): string {
    return albionAbilityIconUrl(spellId);
  }

  protected onIconError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  protected secondsLabel(value: number): string {
    return this.t('tests.timeline.seconds', { value: value.toFixed(1) });
  }

  protected laneLabel(lane: TimelineLane): string {
    return this.t('tests.timeline.laneLabel', {
      label: lane.group.label,
      side: lane.group.side === 'enemy' ? this.t('tests.enemy') : this.t('tests.ally'),
      count: lane.clips.length,
    });
  }

  protected clipLabel(clip: TimelineClip): string {
    return this.t('tests.timeline.clipLabel', {
      spell: clip.cast.spell_id || this.t('tests.pickSpell'),
      at: this.secondsLabel(clip.cast.cast_at),
      targets: clip.cast.target_ids.length,
    });
  }

  /** A spell the caster's weapon does not list. Kept, but drawn as the anomaly it is. */
  protected isForeign(clip: TimelineClip): boolean {
    const known = this.knownSpellIdsByGroup()[clip.cast.caster_group_id];
    if (!known || known.size === 0 || !clip.cast.spell_id) return false;
    return !known.has(clip.cast.spell_id);
  }

  protected isUnknown(clip: TimelineClip): boolean {
    return this.unknownSpellIds().has(clip.cast.spell_id);
  }

  /** Width of the recharge shadow, or `0` when the catalog does not state a cooldown. */
  protected cooldownWidth(clip: TimelineClip): number {
    const seconds = parseCooldownSeconds(this.cooldownsBySpell()[clip.cast.spell_id]);
    return seconds === null ? 0 : this.x(seconds);
  }

  /**
   * A lane's own height, bound rather than left to the CSS.
   *
   * `laneIndexAtY` resolves the drop lane from exactly this arithmetic, so a height that came from
   * a stylesheet instead would let the two drift and drop a clip on the wrong lane.
   */
  protected laneRowHeight(lane: TimelineLane): number {
    return LANE_BASE_HEIGHT + lane.rows * (CLIP_HEIGHT + CLIP_GAP);
  }

  protected subRowsHeight(lane: TimelineLane): number {
    return Math.min(lane.unitIds.length, MAX_VISIBLE_SUBROWS) * SUBROW_HEIGHT;
  }

  protected isExpanded(lane: TimelineLane): boolean {
    return this.expandedGroupIds().has(lane.group.id);
  }

  protected toggleLane(lane: TimelineLane): void {
    this.expandedGroupIds.update((current) => {
      const next = new Set(current);
      if (next.has(lane.group.id)) next.delete(lane.group.id);
      else next.add(lane.group.id);
      return next;
    });
  }

  protected zoomBy(delta: number): void {
    this.zoomIndex.update((index) => Math.min(this.maxZoomIndex, Math.max(0, index + delta)));
  }

  /** One row per unit instance: its hit-point curve, its death, and the casts that named it. */
  protected subRowsFor(lane: TimelineLane): SubRow[] {
    const run = this.visibleResult();
    const outcomes = this.outcomes();
    const duration = this.duration();
    const landTimes = this.landTimes();
    return lane.unitIds.map((unitId) => {
      const outcome = outcomes.get(unitId) ?? null;
      const targetMarks = this.definition()
        .casts.map((cast, index) => ({ cast, index }))
        .filter((entry) => entry.cast.target_ids.includes(unitId))
        .map((entry) => ({
          x: this.x(landTimes[entry.index] ?? entry.cast.cast_at),
          healing: (run?.casts ?? []).some(
            (log) =>
              log.spell_id === entry.cast.spell_id &&
              log.target_ids.includes(unitId) &&
              log.per_target_health_change > 0,
          ),
        }));
      if (!run || !outcome) {
        return {
          unitId,
          outcome,
          segments: [],
          diedAtX: null,
          replayMismatch: false,
          targetMarks,
        };
      }
      const { segments, replayMismatch } = hpSegmentsFor(
        outcome,
        logsTargeting(unitId, run),
        duration,
      );
      return {
        unitId,
        outcome,
        replayMismatch,
        targetMarks,
        diedAtX: outcome.died_at !== null ? this.x(outcome.died_at) : null,
        segments: segments.map((segment) => {
          const share = outcome.starting_hp > 0 ? segment.hp / outcome.starting_hp : 0;
          return {
            x: this.x(segment.fromSeconds),
            width: Math.max(0, this.x(segment.toSeconds - segment.fromSeconds)),
            heightPercent: Math.min(100, share * 100),
            tone:
              share > 0.6
                ? 'var(--color-success)'
                : share > 0.3
                  ? 'var(--color-warning)'
                  : 'var(--color-error)',
          };
        }),
      };
    });
  }

  // ---- Library drag (HTML5) ----

  /** Told by the library that a drag started, because `dataTransfer` is unreadable on `dragover`. */
  onLibraryDragStart(payload: { casterGroupId: string; spellId: string }): void {
    this.libraryDrag = payload;
  }

  onLibraryDragEnd(): void {
    this.libraryDrag = null;
    this.dropPreview.set(null);
  }

  protected onDragOver(event: DragEvent, laneIndex: number): void {
    if (!this.canManage() || !this.libraryDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dropPreview.set({ laneIndex, seconds: this.secondsAtClientX(event, 0) });
  }

  protected onDragLeave(event: DragEvent): void {
    const target = event.currentTarget as HTMLElement;
    const related = event.relatedTarget as Node | null;
    // Without this guard the preview flickers as the cursor crosses the clips inside the lane.
    if (related && target.contains(related)) return;
    this.dropPreview.set(null);
  }

  protected onDrop(event: DragEvent, laneIndex: number): void {
    event.preventDefault();
    this.dropPreview.set(null);
    if (!this.canManage()) return;
    const payload = this.readDragPayload(event) ?? this.libraryDrag;
    this.libraryDrag = null;
    if (!payload) return;
    const lane = this.lanes()[laneIndex];
    if (!lane) return;
    const castAt = this.secondsAtClientX(event, 0);
    this.castCreated.emit({
      casterGroupId: lane.group.id,
      spellId: payload.spellId,
      castAt,
    });
    this.announce('tests.timeline.added', {
      spell: payload.spellId,
      at: this.secondsLabel(castAt),
    });
  }

  private readDragPayload(event: DragEvent): { casterGroupId: string; spellId: string } | null {
    try {
      const raw = event.dataTransfer?.getData('text/plain');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<{
        kind: string;
        casterGroupId: string;
        spellId: string;
      }>;
      if (parsed?.kind === 'spell' && parsed.casterGroupId && parsed.spellId) {
        return { casterGroupId: parsed.casterGroupId, spellId: parsed.spellId };
      }
    } catch {
      // Anything that is not our own payload is not ours to act on.
    }
    return null;
  }

  // ---- Clip drag (pointer events) ----

  protected onPointerDown(event: PointerEvent, clip: TimelineClip): void {
    if (!this.canManage() || event.button !== 0) return;
    const clipRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.pointerDrag = {
      pointerId: event.pointerId,
      castIndex: clip.castIndex,
      startX: event.clientX,
      startY: event.clientY,
      grabOffset: event.clientX - clipRect.left,
      moved: false,
    };
    // Optional-call: jsdom has no pointer capture, and the drag works without it because the moves
    // are tracked on the document.
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const container = this.lanesContainer()?.nativeElement;
    const laneIndex = container
      ? (laneIndexAtY(
          event.clientY - container.getBoundingClientRect().top,
          this.lanes(),
          this.expandedGroupIds(),
        ) ?? 0)
      : 0;
    this.dropPreview.set({
      laneIndex,
      seconds: this.secondsAtClientX(event, drag.grabOffset, event.altKey),
    });
  }

  protected onPointerUp(event: PointerEvent): void {
    const drag = this.pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const preview = this.dropPreview();
    this.pointerDrag = null;
    this.dropPreview.set(null);
    if (!drag.moved || !preview) return;
    const lane = this.lanes()[preview.laneIndex];
    const cast = this.definition().casts[drag.castIndex];
    if (!lane || !cast) return;
    this.castMoved.emit({
      index: drag.castIndex,
      castAt: preview.seconds,
      casterGroupId: lane.group.id,
    });
    this.announce(
      lane.group.id === cast.caster_group_id ? 'tests.timeline.moved' : 'tests.timeline.movedLane',
      {
        spell: cast.spell_id,
        at: this.secondsLabel(preview.seconds),
        label: lane.group.label,
      },
    );
  }

  protected cancelDrag(): void {
    this.pointerDrag = null;
    this.dropPreview.set(null);
  }

  protected onClipClick(event: MouseEvent, clip: TimelineClip): void {
    // A press that turned into a drag still fires a click; selecting on it would fight the move.
    if (this.pointerDrag?.moved) return;
    this.castSelected.emit(clip.castIndex);
  }

  // ---- Keyboard ----

  protected onClipKeydown(event: KeyboardEvent, clip: TimelineClip): void {
    if (!this.canManage()) return;
    const step = event.shiftKey ? 1 : 0.1;
    switch (event.key) {
      case 'ArrowLeft':
        this.moveClip(event, clip, clip.cast.cast_at - step, 0);
        return;
      case 'ArrowRight':
        this.moveClip(event, clip, clip.cast.cast_at + step, 0);
        return;
      case 'ArrowUp':
        this.moveClip(event, clip, clip.cast.cast_at, -1);
        return;
      case 'ArrowDown':
        this.moveClip(event, clip, clip.cast.cast_at, 1);
        return;
      case 'Home':
        this.moveClip(event, clip, 0, 0);
        return;
      case 'End':
        this.moveClip(event, clip, Math.max(0, this.duration() - 1), 0);
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        this.castRemoved.emit(clip.castIndex);
        this.announce('tests.timeline.removed', { spell: clip.cast.spell_id });
        return;
      case 'Escape':
        this.cancelDrag();
        return;
      default:
    }
  }

  private moveClip(
    event: KeyboardEvent,
    clip: TimelineClip,
    castAt: number,
    laneDelta: number,
  ): void {
    const lanes = this.lanes();
    const currentLane = lanes.findIndex((lane) => lane.group.id === clip.cast.caster_group_id);
    const targetLane = lanes[Math.min(lanes.length - 1, Math.max(0, currentLane + laneDelta))];
    if (!targetLane) return;
    event.preventDefault();
    const snapped = snapSeconds(castAt);
    this.castMoved.emit({
      index: clip.castIndex,
      castAt: snapped,
      casterGroupId: targetLane.group.id,
    });
    this.announce(laneDelta === 0 ? 'tests.timeline.moved' : 'tests.timeline.movedLane', {
      spell: clip.cast.spell_id,
      at: this.secondsLabel(snapped),
      label: targetLane.group.label,
    });
  }

  // ---- Shared ----

  /**
   * The time a pointer or drag event points at, in the track's own coordinates.
   *
   * The rect is read live rather than captured at the start of a drag, so scrolling mid-drag stays
   * honest. A cast within a few pixels of another one snaps onto its exact time — lining bursts up
   * is the single most common reason to move a clip at all.
   */
  private secondsAtClientX(
    event: { clientX: number; currentTarget?: EventTarget | null },
    grabOffset: number,
    free = false,
  ): number {
    const track =
      (event.currentTarget as HTMLElement | null)?.closest?.('[data-track]') ??
      this.lanesContainer()?.nativeElement.querySelector('[data-track]');
    const left = track ? track.getBoundingClientRect().left : 0;
    const raw = xToSeconds(event.clientX - grabOffset - left, this.pxPerSecond());
    if (free) return snapSeconds(raw, false);
    const rawX = secondsToX(raw, this.pxPerSecond());
    const magnet = this.definition().casts.find(
      (cast) => Math.abs(secondsToX(cast.cast_at, this.pxPerSecond()) - rawX) <= MAGNET_PX,
    );
    return magnet ? magnet.cast_at : snapSeconds(raw);
  }

  private announce(key: TranslationKey, params: Record<string, string | number>): void {
    this.announcement.set(this.t(key, params));
  }
}
