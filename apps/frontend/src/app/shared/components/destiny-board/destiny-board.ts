import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { AlbionCombatCategory } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import {
  buildDestinyBoardTree,
  clampMasteryLevel,
  collectLeaves,
  filterDestinyTree,
  findDestinyNode,
  isDestinyGroup,
  layoutDestinyRadial,
  setLevelsForKeys,
  type DestinyHue,
  type DestinyItemNode,
  type DestinyRadialNode,
} from '../../data/albion-destiny-board';
import { Dialog } from '../dialog/dialog';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { Icon } from '../icon/icon';
import { Loading } from '../loading/loading';

const HUE_COLOR: Record<DestinyHue, string> = {
  warrior: '#eb5757',
  hunter: '#27a644',
  mage: '#02b8cc',
  gathering: '#8a8f98',
  neutral: '#d0d6e0',
};

/**
 * Radial Destiny Board: weapons fan left, armor fans right, like Albion's combat tree.
 *
 * Click a leaf to set 0–120 with a slider and number. Click a branch (or the
 * centre hub) to set or reset every child. Persistence stays with the parent.
 */
@Component({
  selector: 'app-destiny-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, ErrorState, Icon, Loading],
  styles: `
    .destiny-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      align-items: center;
    }
    .destiny-stage {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(16rem, 19rem);
      gap: 0.75rem;
      align-items: start;
    }
    @media (max-width: 860px) {
      .destiny-stage {
        grid-template-columns: 1fr;
      }
    }
    .destiny-map {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-xl, 12px);
      background:
        radial-gradient(circle at center, rgba(255, 255, 255, 0.03), transparent 58%),
        var(--color-surface-2);
      height: min(86vh, 68rem);
      min-height: 36rem;
      accent-color: var(--color-primary);
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    .destiny-map.is-panning {
      cursor: grabbing;
    }
    .destiny-scene {
      width: 100%;
      height: 100%;
      transform-origin: center center;
      will-change: transform;
    }
    .destiny-map svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .destiny-zoom {
      position: absolute;
      right: 0.75rem;
      bottom: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      z-index: 2;
    }
    .destiny-zoom button {
      min-width: 2rem;
    }
    .destiny-zoom__level {
      text-align: center;
      font-size: 0.65rem;
      font-variant-numeric: tabular-nums;
      color: var(--color-text-secondary);
    }
    .destiny-dot {
      cursor: pointer;
    }
    .destiny-dot:focus-visible {
      outline: 2px solid var(--color-paper, #fff);
      outline-offset: 2px;
    }
    .destiny-inspector {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-xl, 12px);
      background: var(--color-surface);
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      position: sticky;
      top: 0.5rem;
    }
    .destiny-inspector__head {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .destiny-icon {
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 6px;
      object-fit: contain;
      background: var(--color-surface-2);
      flex-shrink: 0;
    }
    .destiny-controls {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.5rem;
      align-items: center;
    }
    .destiny-controls input[type='range'] {
      width: 100%;
      accent-color: var(--color-primary);
    }
    .destiny-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
      font-size: 0.7rem;
      color: var(--color-text-secondary);
    }
    .destiny-legend i {
      display: inline-block;
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 99px;
      margin-right: 0.3rem;
    }
    .destiny-actions {
      position: sticky;
      bottom: 0.5rem;
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 0.75rem;
      padding: 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md, 6px);
      background: var(--color-surface);
    }
    @supports not (accent-color: var(--color-primary)) {
      .destiny-controls input[type='range'] {
        appearance: none;
        background: transparent;
        height: 1.25rem;
      }
      .destiny-controls input[type='range']::-webkit-slider-runnable-track {
        height: 6px;
        border-radius: 99px;
        background: var(--color-graphite);
      }
      .destiny-controls input[type='range']::-webkit-slider-thumb {
        appearance: none;
        width: 14px;
        height: 14px;
        margin-top: -4px;
        border-radius: 99px;
        background: var(--color-primary);
      }
    }
  `,
  template: `
    @if (loading()) {
      <div class="p-8 flex justify-center">
        <app-loading [label]="t('common.loading')" />
      </div>
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('destiny.loadError')"
        [retryLabel]="t('common.retry')"
        (retry)="retry.emit()"
      />
    } @else {
      <div class="destiny-toolbar">
        <div class="flex-1 min-w-[12rem]" role="search">
          <input
            class="input w-full"
            type="search"
            [value]="search()"
            [attr.aria-label]="t('destiny.search')"
            [placeholder]="t('destiny.search')"
            (input)="onSearch($event)"
          />
        </div>
        <select
          class="input w-auto"
          [value]="category()"
          [attr.aria-label]="t('common.category')"
          (change)="onCategory($event)"
        >
          <option value="all">{{ t('destiny.filter.all') }}</option>
          <option value="weapon">{{ t('destiny.filter.weapons') }}</option>
          <option value="armor">{{ t('destiny.filter.armor') }}</option>
        </select>
        @if (editable()) {
          <button type="button" class="btn btn--outline btn--sm" (click)="confirmResetBoard.set(true)">
            {{ t('destiny.resetBoard') }}
          </button>
        }
      </div>

      @if (layout().nodes.length <= 1) {
        <app-empty-state icon="search" [message]="t('destiny.empty')" />
      } @else {
        <div class="destiny-stage">
          <div
            class="destiny-map"
            #destinyMap
            [class.is-panning]="panning()"
            (pointerdown)="onMapPointerDown($event)"
            (pointermove)="onMapPointerMove($event)"
            (pointerup)="onMapPointerUp($event)"
            (pointercancel)="onMapPointerUp($event)"
            (dblclick)="zoomAt($event, 1.35)"
          >
            <div class="destiny-scene" [style.transform]="sceneTransform()">
            <svg
              [attr.viewBox]="'0 0 ' + layout().width + ' ' + layout().height"
              role="img"
              [attr.aria-label]="t('destiny.mapLabel')"
            >
              <defs>
                @for (node of layout().nodes; track node.id) {
                  @if (node.icon) {
                    <clipPath [attr.id]="iconClipId(node.id)">
                      <circle
                        [attr.cx]="node.x"
                        [attr.cy]="node.y"
                        [attr.r]="iconRadius(node)"
                      />
                    </clipPath>
                  }
                }
              </defs>
              @for (edge of layout().edges; track edge.id) {
                <line
                  [attr.x1]="edge.x1"
                  [attr.y1]="edge.y1"
                  [attr.x2]="edge.x2"
                  [attr.y2]="edge.y2"
                  [attr.stroke]="hueColor(edge.hue)"
                  [attr.stroke-opacity]="edgeOpacity(edge.fill, edge.id)"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              }
              @for (node of layout().nodes; track node.id) {
                <g
                  class="destiny-dot"
                  role="button"
                  tabindex="0"
                  [attr.aria-label]="nodeAria(node)"
                  [attr.aria-pressed]="selectedId() === node.id"
                  (click)="selectNode(node.id)"
                  (keydown)="onNodeKey($event, node.id)"
                >
                  <circle
                    [attr.cx]="node.x"
                    [attr.cy]="node.y"
                    r="12"
                    fill="transparent"
                  />
                  <circle
                    [attr.cx]="node.x"
                    [attr.cy]="node.y"
                    [attr.r]="nodeRadius(node)"
                    [attr.fill]="node.icon ? '#0f1011' : nodeFill(node)"
                    [attr.stroke]="selectedId() === node.id ? '#ffffff' : hueColor(node.hue)"
                    [attr.stroke-width]="selectedId() === node.id ? 2.4 : 1.2"
                    [attr.opacity]="nodeOpacity(node)"
                  />
                  @if (node.icon) {
                    <image
                      [attr.href]="node.icon"
                      [attr.x]="node.x - iconRadius(node)"
                      [attr.y]="node.y - iconRadius(node)"
                      [attr.width]="iconRadius(node) * 2"
                      [attr.height]="iconRadius(node) * 2"
                      [attr.clip-path]="'url(#' + iconClipId(node.id) + ')'"
                      [attr.opacity]="nodeOpacity(node)"
                      preserveAspectRatio="xMidYMid slice"
                      style="pointer-events: none"
                    />
                  }
                  @if (node.depth <= 2 && nodeLabel(node); as label) {
                    <text
                      [attr.x]="node.x"
                      [attr.y]="node.y + nodeRadius(node) + 11"
                      text-anchor="middle"
                      fill="var(--color-mist, #d0d6e0)"
                      font-size="12"
                      font-weight="500"
                      style="pointer-events: none"
                    >
                      {{ label }}
                    </text>
                  }
                </g>
              }
            </svg>
            </div>
            <div class="destiny-zoom" (pointerdown)="$event.stopPropagation()">
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [attr.aria-label]="t('destiny.zoomIn')"
                (click)="nudgeZoom(1.25)"
              >
                +
              </button>
              <span class="destiny-zoom__level">{{ zoomPercent() }}%</span>
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [attr.aria-label]="t('destiny.zoomOut')"
                (click)="nudgeZoom(0.8)"
              >
                −
              </button>
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [attr.aria-label]="t('destiny.zoomReset')"
                (click)="resetView()"
              >
                {{ t('destiny.zoomReset') }}
              </button>
            </div>
          </div>

          <aside class="destiny-inspector" [attr.aria-label]="t('destiny.title')">
            @if (selected(); as current) {
              <div class="destiny-inspector__head">
                @if (current.item?.icon) {
                  <img class="destiny-icon" [src]="current.item!.icon!" [alt]="nodeLabel(current)" />
                } @else {
                  <span class="destiny-icon flex items-center justify-center">
                    <app-icon [name]="current.item ? 'swords' : 'shield'" size="1rem" />
                  </span>
                }
                <div class="min-w-0">
                  <p class="text-sm font-semibold truncate" style="color: var(--color-text)">
                    {{ nodeLabel(current) }}
                  </p>
                  <p class="text-[11px] font-mono" style="color: var(--color-text-secondary)">
                    {{ t('destiny.trained', { trained: trainedCount(current), total: current.leafCount }) }}
                    · {{ t('destiny.level', { level: inspectorLevel() }) }}
                  </p>
                </div>
              </div>

              @if (editable()) {
                <div class="destiny-controls">
                  <label class="sr-only" for="destiny-slider">{{ t('destiny.levelInput', { name: nodeLabel(current) }) }}</label>
                  <input
                    id="destiny-slider"
                    type="range"
                    min="0"
                    max="120"
                    step="1"
                    [value]="inspectorLevel()"
                    (input)="onInspectorLevel($event)"
                  />
                  <input
                    class="input input--sm w-16"
                    type="number"
                    min="0"
                    max="120"
                    step="1"
                    [attr.aria-label]="t('destiny.levelInput', { name: nodeLabel(current) })"
                    [value]="inspectorLevel()"
                    (input)="onInspectorLevel($event)"
                  />
                </div>
                @if (!current.item) {
                  <p class="text-[11px]" style="color: var(--color-text-secondary)">{{ t('destiny.setAll') }}</p>
                }
                <button type="button" class="btn btn--outline btn--sm" (click)="resetSelection()">
                  {{ resetLabel(current) }}
                </button>
              }
            } @else {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('destiny.inspectorHint') }}</p>
            }
            <div class="destiny-legend">
              <span><i [style.background]="hueColor('warrior')"></i>{{ t('destiny.legend.warrior') }}</span>
              <span><i [style.background]="hueColor('hunter')"></i>{{ t('destiny.legend.hunter') }}</span>
              <span><i [style.background]="hueColor('mage')"></i>{{ t('destiny.legend.mage') }}</span>
            </div>
          </aside>
        </div>
      }

      @if (editable() && dirty()) {
        <div class="destiny-actions">
          <button type="button" class="btn btn--ghost btn--sm" (click)="resetDraft()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            [disabled]="saving() || invalid()"
            (click)="onSave()"
          >
            {{ saving() ? t('destiny.saving') : t('destiny.save') }}
          </button>
        </div>
      }
    }

    @if (confirmResetBoard()) {
      <app-dialog [title]="t('destiny.resetBoard')" (closed)="confirmResetBoard.set(false)">
        <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('destiny.resetBoardConfirm') }}</p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="confirmResetBoard.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--primary btn--sm" (click)="resetBoard()">
            {{ t('destiny.resetBoard') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class DestinyBoard {
  private readonly translate = inject(TranslateService);

  readonly nodes = input.required<readonly DestinyItemNode[]>();
  readonly editable = input(false);
  readonly loading = input(false);
  readonly loadFailed = input(false);
  readonly saving = input(false);

  readonly retry = output<void>();
  readonly save = output<DestinyItemNode[]>();

  protected readonly search = signal('');
  protected readonly category = signal<AlbionCombatCategory | 'all'>('all');
  protected readonly selectedId = signal('root');
  protected readonly confirmResetBoard = signal(false);
  protected readonly zoom = signal(1.7);
  protected readonly panX = signal(0);
  protected readonly panY = signal(0);
  protected readonly panning = signal(false);
  private readonly draft = signal<DestinyItemNode[]>([]);
  private readonly mapEl = viewChild<ElementRef<HTMLElement>>('destinyMap');
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  private skipClick = false;

  constructor() {
    effect(() => {
      const incoming = this.nodes();
      untracked(() => {
        this.draft.set(incoming.map((node) => ({ ...node })));
      });
    });
    effect((onCleanup) => {
      const element = this.mapEl()?.nativeElement;
      if (!element) return;
      const onWheel = (event: WheelEvent) => this.onMapWheel(event);
      element.addEventListener('wheel', onWheel, { passive: false });
      onCleanup(() => element.removeEventListener('wheel', onWheel));
    });
  }

  protected readonly sceneTransform = computed(
    () => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`,
  );

  protected readonly zoomPercent = computed(() => Math.round(this.zoom() * 100));

  protected readonly visibleTree = computed(() =>
    filterDestinyTree(buildDestinyBoardTree(this.draft()), this.search(), this.category()),
  );

  protected readonly layout = computed(() => layoutDestinyRadial(this.visibleTree()));

  protected readonly selected = computed(
    () => this.layout().nodes.find((node) => node.id === this.selectedId()) ?? null,
  );

  protected readonly inspectorLevel = computed(() => {
    const current = this.selected();
    if (!current || current.leafCount <= 0) return 0;
    return clampMasteryLevel(current.sum / current.leafCount);
  });

  protected readonly dirty = computed(() => {
    const original = new Map(this.nodes().map((node) => [node.node_key, node.level]));
    return this.draft().some((node) => original.get(node.node_key) !== node.level);
  });

  protected readonly invalid = computed(() =>
    this.draft().some((node) => !Number.isInteger(node.level) || node.level < 0 || node.level > 120),
  );

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected hueColor(hue: DestinyHue): string {
    return HUE_COLOR[hue];
  }

  protected nodeRadius(node: DestinyRadialNode): number {
    if (node.depth === 0) return 16;
    if (node.depth === 1) return 13;
    if (node.item) return 9;
    return 11;
  }

  protected iconRadius(node: DestinyRadialNode): number {
    return Math.max(4, this.nodeRadius(node) - 1.2);
  }

  protected iconClipId(id: string): string {
    return `destiny-icon-${id.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  protected nodeFill(node: DestinyRadialNode): string {
    const amount = node.leafCount <= 0 ? 0 : node.sum / (node.leafCount * 120);
    return amount <= 0 ? '#161718' : this.hueColor(node.hue);
  }

  protected nodeOpacity(node: DestinyRadialNode): number {
    const query = this.search().trim().toLowerCase();
    if (query && !this.nodeMatchesQuery(node, query)) return 0.22;
    const amount = node.leafCount <= 0 ? 0 : node.sum / (node.leafCount * 120);
    return 0.35 + amount * 0.65;
  }

  protected edgeOpacity(fill: number, edgeId: string): number {
    const query = this.search().trim().toLowerCase();
    if (query) {
      const targetId = edgeId.split('->')[1] ?? '';
      const target = this.layout().nodes.find((node) => node.id === targetId);
      if (target && !this.nodeMatchesQuery(target, query)) return 0.08;
    }
    return 0.28 + fill * 0.5;
  }

  protected nodeLabel(node: DestinyRadialNode): string {
    if (node.item) return node.item.node_name;
    if (node.labelKey) return this.t(node.labelKey as TranslationKey);
    return node.id;
  }

  protected nodeAria(node: DestinyRadialNode): string {
    return `${this.nodeLabel(node)}, ${this.t('destiny.level', { level: this.inspectorLevelFor(node) })}`;
  }

  protected trainedCount(node: DestinyRadialNode): number {
    if (node.item) return node.item.level > 0 ? 1 : 0;
    const found = node.id === 'root' ? null : findDestinyNode(this.visibleTree(), node.id);
    if (!found) {
      return this.draft().filter((item) => item.level > 0).length;
    }
    return collectLeaves(found).filter((item) => item.level > 0).length;
  }

  protected selectNode(id: string): void {
    if (this.skipClick) {
      this.skipClick = false;
      return;
    }
    this.selectedId.set(id);
  }

  protected nudgeZoom(factor: number): void {
    this.setZoom(this.zoom() * factor, 0, 0);
  }

  protected resetView(): void {
    this.zoom.set(1.7);
    this.panX.set(0);
    this.panY.set(0);
  }

  protected zoomAt(event: MouseEvent, factor: number): void {
    const map = this.mapEl()?.nativeElement;
    if (!map) {
      this.nudgeZoom(factor);
      return;
    }
    const rect = map.getBoundingClientRect();
    this.setZoom(this.zoom() * factor, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  }

  protected onMapPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const map = this.mapEl()?.nativeElement;
    if (!map) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    map.setPointerCapture(event.pointerId);
  }

  protected onMapPointerMove(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    const dx = event.clientX - this.drag.x;
    const dy = event.clientY - this.drag.y;
    if (!this.drag.moved && dx * dx + dy * dy < 16) return;
    this.drag.moved = true;
    this.panning.set(true);
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
    this.panX.update((value) => value + dx);
    this.panY.update((value) => value + dy);
  }

  protected onMapPointerUp(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    if (this.drag.moved) this.skipClick = true;
    this.drag = null;
    this.panning.set(false);
  }

  private onMapWheel(event: WheelEvent): void {
    event.preventDefault();
    const map = this.mapEl()?.nativeElement;
    if (!map) return;
    const rect = map.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.setZoom(
      this.zoom() * factor,
      event.clientX - rect.left - rect.width / 2,
      event.clientY - rect.top - rect.height / 2,
    );
  }

  private setZoom(next: number, originX: number, originY: number): void {
    const zoom = Math.min(6, Math.max(0.75, next));
    const previous = this.zoom();
    if (zoom === previous) return;
    const ratio = zoom / previous;
    this.panX.update((value) => originX - (originX - value) * ratio);
    this.panY.update((value) => originY - (originY - value) * ratio);
    this.zoom.set(zoom);
  }

  protected onNodeKey(event: KeyboardEvent, id: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.selectNode(id);
    }
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected onCategory(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.category.set(value === 'weapon' || value === 'armor' ? value : 'all');
  }

  protected onInspectorLevel(event: Event): void {
    if (!this.editable()) return;
    const level = Number((event.target as HTMLInputElement).value);
    this.applyToSelection(level);
  }

  protected resetSelection(): void {
    if (this.selected()?.id === 'root') {
      this.confirmResetBoard.set(true);
      return;
    }
    this.applyToSelection(0);
  }

  protected resetBoard(): void {
    this.confirmResetBoard.set(false);
    this.selectedId.set('root');
    this.applyToSelection(0);
  }

  protected resetDraft(): void {
    this.draft.set(this.nodes().map((node) => ({ ...node })));
  }

  protected onSave(): void {
    if (!this.editable() || this.invalid() || this.saving()) return;
    this.save.emit(this.draft().map((node) => ({ ...node })));
  }

  protected resetLabel(node: DestinyRadialNode): string {
    if (node.id === 'root') return this.t('destiny.resetBoard');
    if (node.item) return this.t('destiny.resetItem');
    return this.t('destiny.resetBranch');
  }

  private applyToSelection(level: number): void {
    const keys = this.selectedKeys();
    if (keys.size === 0) return;
    this.draft.update((items) => setLevelsForKeys(items, keys, level));
  }

  private selectedKeys(): Set<string> {
    const current = this.selected();
    if (!current) return new Set();
    if (current.item) return new Set([current.item.node_key]);
    if (current.id === 'root') return new Set(this.draft().map((item) => item.node_key));
    const found = findDestinyNode(this.visibleTree(), current.id);
    if (!found) return new Set();
    return new Set(collectLeaves(found).map((item) => item.node_key));
  }

  private inspectorLevelFor(node: DestinyRadialNode): number {
    if (node.leafCount <= 0) return 0;
    return clampMasteryLevel(node.sum / node.leafCount);
  }

  private nodeMatchesQuery(node: DestinyRadialNode, query: string): boolean {
    if (this.nodeLabel(node).toLowerCase().includes(query)) return true;
    if (node.item?.identifier.toLowerCase().includes(query)) return true;
    if (node.id === 'root') return true;
    const found = findDestinyNode(this.visibleTree(), node.id);
    if (!found) return false;
    return collectLeaves(found).some(
      (item) =>
        item.node_name.toLowerCase().includes(query) || item.identifier.toLowerCase().includes(query),
    );
  }
}
