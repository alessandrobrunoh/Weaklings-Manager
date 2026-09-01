import {
  Directive,
  ElementRef,
  inject,
  input,
  OnDestroy,
  NgZone,
  Renderer2,
} from '@angular/core';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

let nextTooltipId = 0;

/**
 * Lightweight, accessible tooltip directive.
 *
 * @example
 * <button [appTooltip]="'Aggiorna dati in tempo reale'" tooltipPosition="bottom">
 *   Refresh
 * </button>
 */
@Directive({
  selector: '[appTooltip]',
  standalone: true,
  host: {
    '(mouseenter)': 'onMouseEnter()',
    '(mouseleave)': 'onMouseLeave()',
    '(focusin)': 'onFocusIn()',
    '(focusout)': 'onFocusOut()',
    '(click)': 'onClick()',
    '(window:resize)': 'updatePosition()',
    '(document:scroll)': 'updatePosition()',
  },
})
export class TooltipDirective implements OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly renderer = inject(Renderer2);
  private readonly ngZone = inject(NgZone);

  readonly appTooltip = input<string | null | undefined>();
  readonly tooltipPosition = input<TooltipPosition>('top');
  readonly tooltipDelay = input<number>(120);

  private tooltipEl: HTMLElement | null = null;
  private showTimeout: ReturnType<typeof setTimeout> | null = null;
  private unlistenScroll: (() => void) | null = null;

  constructor() {
    this.ngZone.runOutsideAngular(() => {
      const handler = () => {
        if (this.tooltipEl) {
          this.hide();
        }
      };
      window.addEventListener('scroll', handler, { capture: true, passive: true });
      this.unlistenScroll = () => window.removeEventListener('scroll', handler, { capture: true } as EventListenerOptions);
    });
  }

  onMouseEnter(): void {
    this.scheduleShow();
  }

  onMouseLeave(): void {
    this.hide();
  }

  onFocusIn(): void {
    this.scheduleShow();
  }

  onFocusOut(): void {
    this.hide();
  }

  onClick(): void {
    this.hide();
  }

  ngOnDestroy(): void {
    this.unlistenScroll?.();
    this.hide();
  }

  private scheduleShow(): void {
    const text = this.appTooltip()?.trim();
    if (!text) {
      return;
    }

    this.clearTimeout();
    this.ngZone.runOutsideAngular(() => {
      this.showTimeout = setTimeout(() => {
        this.createAndShow(text);
      }, this.tooltipDelay());
    });
  }

  private createAndShow(text: string): void {
    if (this.tooltipEl) {
      this.tooltipEl.textContent = text;
      this.updatePosition();
      return;
    }

    const tip = this.renderer.createElement('div') as HTMLElement;
    tip.className = 'app-tooltip';
    tip.id = `app-tooltip-${++nextTooltipId}`;
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;

    this.renderer.setAttribute(this.el.nativeElement, 'aria-describedby', tip.id);
    this.renderer.appendChild(document.body, tip);
    this.tooltipEl = tip;

    this.updatePosition();

    requestAnimationFrame(() => {
      if (this.tooltipEl) {
        this.tooltipEl.classList.add('app-tooltip--visible');
      }
    });
  }

  protected updatePosition(): void {
    if (!this.tooltipEl || !this.el.nativeElement) {
      return;
    }

    const hostRect = this.el.nativeElement.getBoundingClientRect();
    const tipRect = this.tooltipEl.getBoundingClientRect();
    const position = this.tooltipPosition();
    const gap = 6;

    let top = 0;
    let left = 0;

    switch (position) {
      case 'bottom':
        top = hostRect.bottom + gap;
        left = hostRect.left + hostRect.width / 2 - tipRect.width / 2;
        break;
      case 'left':
        top = hostRect.top + hostRect.height / 2 - tipRect.height / 2;
        left = hostRect.left - tipRect.width - gap;
        break;
      case 'right':
        top = hostRect.top + hostRect.height / 2 - tipRect.height / 2;
        left = hostRect.right + gap;
        break;
      case 'top':
      default:
        top = hostRect.top - tipRect.height - gap;
        left = hostRect.left + hostRect.width / 2 - tipRect.width / 2;
        break;
    }

    const padding = 8;
    left = Math.max(padding, Math.min(left, window.innerWidth - tipRect.width - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - tipRect.height - padding));

    this.tooltipEl.style.top = `${Math.round(top)}px`;
    this.tooltipEl.style.left = `${Math.round(left)}px`;
  }

  private hide(): void {
    this.clearTimeout();
    if (this.tooltipEl) {
      const tip = this.tooltipEl;
      this.tooltipEl = null;
      this.renderer.removeAttribute(this.el.nativeElement, 'aria-describedby');
      tip.classList.remove('app-tooltip--visible');
      setTimeout(() => {
        if (tip.parentNode) {
          tip.parentNode.removeChild(tip);
        }
      }, 120);
    }
  }

  private clearTimeout(): void {
    if (this.showTimeout !== null) {
      clearTimeout(this.showTimeout);
      this.showTimeout = null;
    }
  }
}
