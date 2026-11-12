import { isPlatformBrowser } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  PLATFORM_ID,
  computed,
  inject,
  input,
  output,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { Icon, type IconName } from '../icon/icon';

/** One tab. Give it a `link` to make the whole set a routed (navigation) tab bar. */
export interface TabOption {
  readonly id: string;
  /** Already translated, visible label. */
  readonly label: string;
  /** Optional leading icon, for sets dense enough to need one. */
  readonly icon?: IconName;
  /** Optional count shown after the label (open requests, rows...). Hidden when null/undefined. */
  readonly count?: number | string | null;
  readonly disabled?: boolean;
  /** Router commands. Present on every option = routed variant (anchors + `aria-current`). */
  readonly link?: string | readonly unknown[];
  /** Query params carried by the link (routed variant only). */
  readonly queryParams?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export type TabsVariant = 'underline' | 'segmented';

let nextTabsId = 0;

/**
 * THE tab bar of the product. Use it for every in-page section switch, routed sub-page set and
 * small view switch; do not hand-roll button rows.
 *
 * Two modes, picked automatically:
 * - **In-page tabs** (default): `role="tablist"` of `role="tab"` buttons, roving `tabindex`,
 *   Left/Right/Home/End move focus and activate (automatic activation), disabled tabs are skipped.
 *   The host owns the active id and updates it from `activeChange`.
 * - **Routed**: when every option has a `link`, it renders a `<nav>` of anchors with `routerLink`;
 *   the active one carries `aria-current="page"`. The host still passes `active` (derive it from
 *   the URL) and may listen to `activeChange` for side effects.
 *
 * Looks: `underline` (default) is a compact bar with a 2px primary underline on the active tab,
 * for sections of a page. `segmented` is a small joined control for inline switches in a toolbar
 * (Mine/Everyone, 7/30/90 days). Both scroll horizontally inside themselves on a phone, never the
 * page, and bring the active tab into view.
 *
 * @example
 * <app-tabs [options]="tabs" [active]="tab()" [ariaLabel]="t('x.sections')" (activeChange)="tab.set($event)" />
 */
@Component({
  selector: 'app-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  host: {
    '[class.tabs-host--segmented]': 'variant() === "segmented"',
  },
  styles: `
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
    }
    :host(.tabs-host--segmented) {
      display: inline-block;
    }
    .tabs-scroll {
      max-width: 100%;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }
    .tabs-scroll::-webkit-scrollbar {
      display: none;
    }
    .tabs {
      display: flex;
      width: max-content;
      min-width: 100%;
      gap: 0.125rem;
      border-bottom: 1px solid var(--color-border);
    }
    .tab {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: var(--control-h);
      margin-bottom: -1px;
      padding: 0.375rem 0.75rem;
      border: 0;
      border-bottom: 2px solid transparent;
      border-radius: var(--radius-sm) var(--radius-sm) 0 0;
      background: transparent;
      color: var(--color-text-secondary);
      font: inherit;
      font-size: var(--ui-text-sm);
      font-weight: 500;
      line-height: 1.25rem;
      white-space: nowrap;
      text-decoration: none;
      cursor: pointer;
      transition:
        color var(--motion-fast),
        background-color var(--motion-fast),
        border-color var(--motion-fast);
    }
    .tab:hover:not([aria-disabled='true']):not(.tab--active) {
      color: var(--color-text);
      background: var(--color-surface-hover);
    }
    .tab--active {
      color: var(--color-text-heading);
      font-weight: 600;
      border-bottom-color: var(--color-primary);
    }
    .tab:focus-visible {
      outline: var(--focus-ring);
      outline-offset: -2px;
      z-index: 1;
    }
    .tab[aria-disabled='true'] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .tab__count {
      min-width: 1.25rem;
      padding: 0 0.375rem;
      border-radius: var(--radius-badges);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
      font-weight: 600;
      line-height: 1.25rem;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .tab--active .tab__count {
      background: var(--color-primary-container);
      color: var(--color-text-heading);
    }

    /* Segmented: a joined control for inline switches. */
    .tabs--segmented {
      min-width: 0;
      gap: 0.125rem;
      padding: 0.125rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
    }
    .tabs--segmented .tab {
      min-height: calc(var(--control-h-sm) - 0.25rem);
      margin: 0;
      padding: 0.125rem 0.625rem;
      border: 0;
      border-radius: var(--radius-sm);
    }
    .tabs--segmented .tab--active {
      background: var(--color-surface);
      box-shadow: 0 0 0 1px var(--color-border-strong);
    }
    .tabs--segmented .tab:focus-visible {
      outline-offset: 1px;
    }

    @media (pointer: coarse) {
      .tab {
        min-height: 2.5rem;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .tab {
        transition: none;
      }
    }
  `,
  template: `
    @if (routed()) {
      <nav class="tabs-scroll" [attr.aria-label]="ariaLabel() || null">
        <div class="tabs" [class.tabs--segmented]="variant() === 'segmented'">
          @for (option of options(); track option.id) {
            <a
              #item
              class="tab"
              [class.tab--active]="option.id === active()"
              [routerLink]="option.link"
              [queryParams]="option.queryParams ?? null"
              [attr.aria-current]="option.id === active() ? 'page' : null"
              [attr.aria-disabled]="option.disabled ? 'true' : null"
              [attr.data-tab-id]="option.id"
              (click)="onLinkClick($event, option)"
            >
              @if (option.icon) {
                <app-icon [name]="option.icon" size="0.95rem" />
              }
              {{ option.label }}
              @if (hasCount(option)) {
                <span class="tab__count">{{ option.count }}</span>
              }
            </a>
          }
        </div>
      </nav>
    } @else {
      <div class="tabs-scroll">
        <div
          class="tabs"
          [class.tabs--segmented]="variant() === 'segmented'"
          role="tablist"
          [attr.aria-label]="ariaLabel() || null"
          (keydown)="onKeydown($event)"
        >
          @for (option of options(); track option.id) {
            <button
              #item
              type="button"
              role="tab"
              class="tab"
              [class.tab--active]="option.id === active()"
              [id]="tabId(option)"
              [attr.aria-selected]="option.id === active()"
              [attr.aria-controls]="panelIdPrefix() ? panelIdPrefix() + option.id : null"
              [attr.aria-disabled]="option.disabled ? 'true' : null"
              [attr.tabindex]="option.id === focusStop() ? 0 : -1"
              [attr.data-tab-id]="option.id"
              (click)="select(option)"
            >
              @if (option.icon) {
                <app-icon [name]="option.icon" size="0.95rem" />
              }
              {{ option.label }}
              @if (hasCount(option)) {
                <span class="tab__count">{{ option.count }}</span>
              }
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class Tabs {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly uid = `app-tabs-${++nextTabsId}`;
  private readonly items = viewChildren<ElementRef<HTMLElement>>('item');

  readonly options = input.required<readonly TabOption[]>();
  /** Id of the active option. */
  readonly active = input.required<string>();
  /** Accessible name of the tab list / navigation, e.g. "Sections". */
  readonly ariaLabel = input('');
  readonly variant = input<TabsVariant>('underline');
  /**
   * Opt-in `aria-controls` wiring: when set, each tab points at the element with id
   * `<panelIdPrefix><option.id>`. Only use it if those panel ids exist.
   */
  readonly panelIdPrefix = input('');

  /** Emits the id of the chosen option (click or keyboard). The host updates `active`. */
  readonly activeChange = output<string>();

  /** Routed when every option carries a link. */
  protected readonly routed = computed(() => {
    const options = this.options();
    return options.length > 0 && options.every((option) => option.link !== undefined);
  });

  /** The tab that sits in the Tab order: the active one, else the first enabled one. */
  protected readonly focusStop = computed(() => {
    const options = this.options();
    if (options.some((option) => option.id === this.active() && !option.disabled)) {
      return this.active();
    }
    return options.find((option) => !option.disabled)?.id ?? null;
  });

  constructor() {
    // Keep the active tab visible when the bar scrolls (phone widths, long sets).
    afterRenderEffect(() => {
      const active = this.active();
      if (!isPlatformBrowser(this.platformId)) {
        return;
      }
      const el = this.items().find((item) => item.nativeElement.dataset['tabId'] === active)
        ?.nativeElement;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }

  protected tabId(option: TabOption): string {
    return `${this.uid}-${option.id}`;
  }

  protected hasCount(option: TabOption): boolean {
    return option.count !== null && option.count !== undefined && option.count !== '';
  }

  protected select(option: TabOption): void {
    if (option.disabled) {
      return;
    }
    this.activeChange.emit(option.id);
  }

  protected onLinkClick(event: Event, option: TabOption): void {
    if (option.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.activeChange.emit(option.id);
  }

  /** Left/Right/Home/End roving focus, wrapping at the ends, skipping disabled tabs. */
  protected onKeydown(event: KeyboardEvent): void {
    const options = this.options();
    const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((i) => i >= 0);
    if (enabled.length === 0) {
      return;
    }
    const currentIndex = options.findIndex((option) => option.id === this.active());
    const position = enabled.indexOf(currentIndex);

    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = enabled[(position + 1 + enabled.length) % enabled.length];
        break;
      case 'ArrowLeft':
        next = enabled[(position - 1 + enabled.length) % enabled.length];
        break;
      case 'Home':
        next = enabled[0];
        break;
      case 'End':
        next = enabled[enabled.length - 1];
        break;
      default:
        return;
    }

    event.preventDefault();
    const target = options[next];
    this.activeChange.emit(target.id);
    this.items()
      .find((item) => item.nativeElement.dataset['tabId'] === target.id)
      ?.nativeElement.focus();
  }
}
