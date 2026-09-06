/**
 * The arithmetic behind the combat-test timeline editor: time/pixel mapping, lane layout, clip
 * packing, and the replay that turns a finished run back into per-unit hit-point curves.
 *
 * Everything here is pure. The editor components render what these functions compute and own no
 * numbers of their own, which keeps the layout identical on the server (the app renders with
 * `analog({ ssr: true })`, so first paint cannot measure the DOM) and makes the whole model
 * testable without a `TestBed`.
 */

import type {
  OpenAlbionItemAbilities,
  ScenarioDeclaredCast,
  ScenarioDefinition,
  ScenarioResolvedCastLog,
  ScenarioResult,
  ScenarioUnitGroup,
  ScenarioUnitOutcome,
} from '../../../core/models/api.models';

/** Casts land on a tenth of a second — the finest step the editor offers. */
export const TIMELINE_SNAP = 0.1;

/** Pixels per second, one entry per zoom step. */
export const ZOOM_LEVELS = [20, 40, 80, 160, 320] as const;
export const DEFAULT_ZOOM_INDEX = 2;

/**
 * A clip is a fixed-width chip, not a bar: the engine's cast has no duration the frontend can know
 * (`castingtime`/`hitdelay` live in the backend's bundled `spells.json`, which is never served), so
 * a width that scaled with zoom would be inventing information. The cast's instant is the clip's
 * left edge.
 */
export const CLIP_WIDTH = 44;
export const CLIP_HEIGHT = 30;
export const CLIP_GAP = 2;
/** Lane chrome above the clip rows: the group header line. */
export const LANE_BASE_HEIGHT = 44;
export const SUBROW_HEIGHT = 26;
/** Seconds of empty track kept to the right of the last cast, so there is always room to drop. */
export const TRAILING_SECONDS = 2;
export const MIN_DURATION = 10;
/** Units listed in an expanded lane before the sub-row list starts scrolling on its own. */
export const MAX_VISIBLE_SUBROWS = 12;

/** One horizontal track: a unit group, its unit instances, and the casts it makes. */
export interface TimelineLane {
  /**
   * Position in `definition.groups`. Lanes are addressed by index, never by `group.id` — ids can
   * legitimately collide, because the page's `groupSeq` counter restarts at 0 on every reload.
   */
  readonly index: number;
  readonly group: ScenarioUnitGroup;
  readonly unitIds: readonly string[];
  readonly clips: readonly TimelineClip[];
  /**
   * Clip rows this lane renders, at least 1.
   *
   * Deliberately uncapped: a lane that declares eight casts at the same instant is genuinely eight
   * rows tall. Hiding the surplus behind a "+N" would make casts invisible on the one view whose
   * job is to show every cast, and zooming in already separates any stack worth separating.
   */
  readonly rows: number;
}

/** One cast, placed. */
export interface TimelineClip {
  /** Index into `definition.casts` — the address every edit is emitted with. */
  readonly castIndex: number;
  readonly cast: ScenarioDeclaredCast;
  /** Which clip row inside its lane, 0-based. */
  readonly row: number;
  /** Left edge in pixels from the start of the track. */
  readonly x: number;
}

/** A stretch of time over which one unit's hit points held one value. */
export interface HpSegment {
  readonly fromSeconds: number;
  readonly toSeconds: number;
  readonly hp: number;
}

/** One mark on the ruler. Majors carry a label. */
export interface TickMark {
  readonly seconds: number;
  readonly major: boolean;
}

/** A caster's ability list, grouped by slot — the Timeline's spell picker options. */
export interface GroupedSpellOptions {
  readonly group: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/**
 * Every unit instance a definition's groups expand to — `"{id}#0"`..`"{id}#{count-1}"`.
 *
 * Mirrors the backend's `expand_units`: a group with an absent or zero `count` still contributes
 * one unit, which is what `UnitGroup::count`'s serde default and the engine's `max(1, …)` agree on.
 */
export function unitIdsOf(definition: ScenarioDefinition): string[] {
  return definition.groups.flatMap((group) => unitIdsOfGroup(group));
}

/** The unit instance ids one group expands to. */
export function unitIdsOfGroup(group: ScenarioUnitGroup): string[] {
  return Array.from({ length: Math.max(1, group.count ?? 1) }, (_, n) => `${group.id}#${n}`);
}

/**
 * Rounds a time onto the snap grid and clamps it at zero.
 *
 * The `toFixed` is not cosmetic: `1.1 + 0.1` serialises as `1.2000000000000002`, and the page's
 * `dirty()` is a `JSON.stringify` comparison — one un-rounded arrow-key press would leave the
 * editor claiming unsaved changes forever. See {@link normalizeCast}.
 */
export function snapSeconds(value: number, snap = true): number {
  const raw = Number.isFinite(value) ? Math.max(0, value) : 0;
  // Multiply by the reciprocal rather than dividing by the step: `0.15 / 0.1` is 1.4999999999999998
  // and would round a midpoint *down*, while `0.15 * 10` is exactly 1.5 and rounds the way a reader
  // of "snaps to a tenth" expects.
  const stepped = snap ? Math.round(raw * (1 / TIMELINE_SNAP)) * TIMELINE_SNAP : raw;
  return Number(stepped.toFixed(1));
}

export function secondsToX(seconds: number, pxPerSecond: number): number {
  return seconds * pxPerSecond;
}

export function xToSeconds(x: number, pxPerSecond: number): number {
  return pxPerSecond > 0 ? x / pxPerSecond : 0;
}

/**
 * Rewrites a cast with a canonical key order and canonical values.
 *
 * `dirty()` compares `JSON.stringify` output, so key order is semantically load-bearing on this
 * page. Normalising both sides on load and on every mutation makes that comparison order-stable by
 * construction, rather than by everyone remembering to spread an existing object instead of
 * building a fresh literal.
 */
export function normalizeCast(cast: ScenarioDeclaredCast): ScenarioDeclaredCast {
  return {
    caster_group_id: cast.caster_group_id,
    spell_id: cast.spell_id,
    cast_at: snapSeconds(cast.cast_at),
    target_ids: [...cast.target_ids].sort(),
    attacker_style: cast.attacker_style ?? 'melee',
  };
}

/** {@link normalizeCast} over a whole definition; groups keep their declaration order. */
export function normalizeDefinition(definition: ScenarioDefinition): ScenarioDefinition {
  return {
    groups: definition.groups.map((group) => ({
      id: group.id,
      side: group.side,
      label: group.label,
      item_id: group.item_id ?? null,
      count: Math.max(1, group.count ?? 1),
      hit_points: group.hit_points ?? 1200,
    })),
    casts: definition.casts.map(normalizeCast),
  };
}

/**
 * How many seconds of track to draw.
 *
 * `dragSeconds` is the position of an in-flight drag, so the track grows under the cursor instead
 * of the drag stopping dead at the old end.
 */
export function timelineDuration(
  definition: ScenarioDefinition,
  result: ScenarioResult | null = null,
  dragSeconds = 0,
): number {
  const times = [
    dragSeconds,
    ...definition.casts.map((cast) => cast.cast_at),
    ...(result?.casts ?? []).map((log) => log.land_at),
    ...(result?.units ?? []).map((unit) => unit.died_at ?? 0),
  ];
  const latest = times.reduce(
    (max, value) => (Number.isFinite(value) && value > max ? value : max),
    0,
  );
  return Math.max(MIN_DURATION, Math.ceil(latest + TRAILING_SECONDS));
}

/** Candidate ruler steps, coarsest last. */
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30] as const;
/** Pixels a labelled tick needs before its neighbour's label would collide. */
const TICK_LABEL_WIDTH = 56;

/**
 * Ruler marks for the visible span: labelled majors at the coarsest step that still fits, plus
 * unlabelled minors a fifth of the way between them.
 */
export function tickMarks(duration: number, pxPerSecond: number): TickMark[] {
  const step =
    TICK_STEPS.find((candidate) => candidate * pxPerSecond >= TICK_LABEL_WIDTH) ??
    TICK_STEPS[TICK_STEPS.length - 1];
  const minor = step / 5;
  const marks: TickMark[] = [];
  const total = Math.round(duration / minor);
  for (let i = 0; i <= total; i += 1) {
    const seconds = Number((i * minor).toFixed(3));
    if (seconds > duration) break;
    marks.push({ seconds, major: Math.abs(seconds / step - Math.round(seconds / step)) < 1e-6 });
  }
  return marks;
}

/**
 * Packs casts into rows so two clips never overlap: greedy lowest-free-row placement, in `cast_at`
 * order. Collision is measured in pixels, so zooming in physically separates a stack — that is the
 * affordance for editing casts declared a tenth of a second apart.
 */
export function assignClipRows(
  casts: readonly { readonly cast_at: number }[],
  pxPerSecond: number,
): number[] {
  const order = casts
    .map((cast, index) => ({ index, x: secondsToX(cast.cast_at, pxPerSecond) }))
    .sort((a, b) => a.x - b.x || a.index - b.index);
  const rowEnds: number[] = [];
  const rows = new Array<number>(casts.length).fill(0);
  for (const entry of order) {
    let row = rowEnds.findIndex((end) => entry.x >= end);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(0);
    }
    rowEnds[row] = entry.x + CLIP_WIDTH + CLIP_GAP;
    rows[entry.index] = row;
  }
  return rows;
}

/** Places one bucket of casts into clips, packed into non-overlapping rows. */
function placeClips(
  entries: readonly { readonly cast: ScenarioDeclaredCast; readonly castIndex: number }[],
  pxPerSecond: number,
): TimelineClip[] {
  const rows = assignClipRows(
    entries.map((entry) => entry.cast),
    pxPerSecond,
  );
  return entries.map((entry, n) => ({
    castIndex: entry.castIndex,
    cast: entry.cast,
    row: rows[n],
    x: secondsToX(entry.cast.cast_at, pxPerSecond),
  }));
}

/** Lanes in group order, each carrying the casts that name it as caster. */
export function buildLanes(definition: ScenarioDefinition, pxPerSecond: number): TimelineLane[] {
  return definition.groups.map((group, index) => {
    const owned = definition.casts
      .map((cast, castIndex) => ({ cast, castIndex }))
      .filter((entry) => entry.cast.caster_group_id === group.id);
    const clips = placeClips(owned, pxPerSecond);
    const neededRows = clips.reduce((max, clip) => Math.max(max, clip.row + 1), 1);
    return {
      index,
      group,
      unitIds: unitIdsOfGroup(group),
      clips,
      rows: neededRows,
    };
  });
}

/**
 * Casts whose `caster_group_id` matches no group — what renaming a group in the Setup tab leaves
 * behind.
 *
 * The engine silently drops these (no caster, so no units), so surfacing them as their own
 * pseudo-lane is the difference between visible work-to-repair and silent data loss.
 */
export function orphanClips(definition: ScenarioDefinition, pxPerSecond: number): TimelineClip[] {
  const known = new Set(definition.groups.map((group) => group.id));
  const owned = definition.casts
    .map((cast, castIndex) => ({ cast, castIndex }))
    .filter((entry) => !known.has(entry.cast.caster_group_id));
  return placeClips(owned, pxPerSecond);
}

/** Total height one lane occupies, expanded or not. */
export function laneHeight(lane: TimelineLane, expanded: boolean): number {
  const clipRows = LANE_BASE_HEIGHT + lane.rows * (CLIP_HEIGHT + CLIP_GAP);
  if (!expanded) return clipRows;
  return clipRows + Math.min(lane.unitIds.length, MAX_VISIBLE_SUBROWS) * SUBROW_HEIGHT;
}

/**
 * Which lane a vertical offset falls in.
 *
 * Deliberately arithmetic rather than `document.elementFromPoint`: pointer capture retargets every
 * move event to the dragged clip, so the document hit test would answer for the clip rather than
 * the lane under the cursor — and jsdom does not implement it at all, so a hit test built on it
 * could be neither correct during a drag nor covered by a spec.
 */
export function laneIndexAtY(
  y: number,
  lanes: readonly TimelineLane[],
  expanded: ReadonlySet<string>,
): number | null {
  if (lanes.length === 0) return null;
  if (y < 0) return 0;
  let offset = 0;
  for (const lane of lanes) {
    offset += laneHeight(lane, expanded.has(lane.group.id));
    if (y < offset) return lane.index;
  }
  return lanes[lanes.length - 1].index;
}

/**
 * Seconds a cooldown string denotes, or `null` when it says nothing usable.
 *
 * The ability catalog stores cooldowns as free text (`"4"`, `"4.5s"`, sometimes an em dash), so a
 * bare `Number()` would turn "no cooldown known" into `0` — a shadow of zero width, claiming the
 * spell can be recast instantly.
 */
export function parseCooldownSeconds(cooldown: string | null | undefined): number | null {
  if (!cooldown) return null;
  const match = /(\d+(?:[.,]\d+)?)/.exec(cooldown);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Groups ability slots into picker option groups, dropping slots that offer nothing. */
export function groupedSpellOptions(
  slots: readonly {
    readonly label: string;
    readonly choices: readonly { readonly id: string; readonly name: string }[];
  }[],
): GroupedSpellOptions[] {
  return slots
    .filter((slot) => slot.choices.length > 0)
    .map((slot) => ({
      group: slot.label,
      options: slot.choices.map((choice) => ({ value: choice.id, label: choice.name })),
    }));
}

/** Every spell id a weapon can cast — for flagging clips that name something else. */
export function spellIdsOf(abilities: OpenAlbionItemAbilities | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!abilities) return ids;
  for (const choices of Object.values(abilities.active)) {
    for (const choice of choices) ids.add(choice.id);
  }
  for (const choices of Object.values(abilities.passive)) {
    for (const choice of choices) ids.add(choice.id);
  }
  return ids;
}

/** `unit id -> outcome`, so a sub-row looks its numbers up in one pass. */
export function unitOutcomeIndex(result: ScenarioResult): Map<string, ScenarioUnitOutcome> {
  return new Map(result.units.map((unit) => [unit.id, unit]));
}

/** The resolved casts that named this unit, in landing order. */
export function logsTargeting(unitId: string, result: ScenarioResult): ScenarioResolvedCastLog[] {
  return result.casts.filter((log) => log.target_ids.includes(unitId));
}

/**
 * Replays one unit's hit points across the burst.
 *
 * Mirrors the engine's `apply_health_change` exactly: damage and healing accumulate **uncapped**
 * and the displayed value is `max(0, starting - damage + healing)` at each step, so overkill and a
 * heal landing after death behave the way the server reports them rather than the way a naive
 * running total clamped at zero would.
 *
 * `replayMismatch` is a self-check against `unit.remaining_hp`: if it trips, this replay has
 * drifted from the engine, and the overlay says so instead of quietly showing wrong numbers.
 */
export function hpSegmentsFor(
  unit: ScenarioUnitOutcome,
  logs: readonly ScenarioResolvedCastLog[],
  duration: number,
): { segments: HpSegment[]; replayMismatch: boolean } {
  const segments: HpSegment[] = [];
  let damage = 0;
  let healing = 0;
  let hp = unit.starting_hp;
  let from = 0;
  for (const log of logs) {
    if (log.per_target_health_change < 0) damage += -log.per_target_health_change;
    else healing += log.per_target_health_change;
    segments.push({ fromSeconds: from, toSeconds: log.land_at, hp });
    from = log.land_at;
    hp = Math.max(0, unit.starting_hp - damage + healing);
  }
  segments.push({ fromSeconds: from, toSeconds: duration, hp });
  return { segments, replayMismatch: Math.abs(hp - unit.remaining_hp) > 1 };
}

/**
 * Pairs each declared cast with the `land_at` the engine gave it, or `null`.
 *
 * `ScenarioResult.casts` is ordered by `land_at` and carries no index back to the declaration, and
 * casts the engine dropped (unknown spell, no targets) are simply absent — so the two lists cannot
 * be zipped directly. Matching within a `(caster_group_id, spell_id)` key, both sides in time
 * order, is exact whenever that key's counts agree, and yields `null` rather than a guess when they
 * do not.
 */
export function matchLandTimes(
  definition: ScenarioDefinition,
  result: ScenarioResult,
): (number | null)[] {
  const keyOf = (casterGroupId: string, spellId: string) => `${casterGroupId} ${spellId}`;
  const declared = new Map<string, number[]>();
  definition.casts.forEach((cast, index) => {
    const key = keyOf(cast.caster_group_id, cast.spell_id);
    const bucket = declared.get(key);
    if (bucket) bucket.push(index);
    else declared.set(key, [index]);
  });
  const resolved = new Map<string, number[]>();
  for (const log of result.casts) {
    const key = keyOf(log.caster_group_id, log.spell_id);
    const bucket = resolved.get(key);
    if (bucket) bucket.push(log.land_at);
    else resolved.set(key, [log.land_at]);
  }

  const out = new Array<number | null>(definition.casts.length).fill(null);
  for (const [key, indices] of declared) {
    const times = resolved.get(key);
    if (!times || times.length !== indices.length) continue;
    const byTime = [...indices].sort(
      (a, b) => definition.casts[a].cast_at - definition.casts[b].cast_at || a - b,
    );
    const sortedTimes = [...times].sort((a, b) => a - b);
    byTime.forEach((castIndex, n) => {
      out[castIndex] = sortedTimes[n];
    });
  }
  return out;
}

/** Unit instances no cast ever names — declared, but never part of the fight. */
export function neverTargetedUnitIds(definition: ScenarioDefinition): string[] {
  const targeted = new Set(definition.casts.flatMap((cast) => cast.target_ids));
  return unitIdsOf(definition).filter((id) => !targeted.has(id));
}
