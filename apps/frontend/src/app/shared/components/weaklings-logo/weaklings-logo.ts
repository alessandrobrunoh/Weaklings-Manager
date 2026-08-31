import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Weaklings brand mark used in auth and navigation surfaces.
 *
 * The mark mirrors the guild logo direction without requiring a raster asset:
 * stacked red triangles, a faceted gem, and an optional compact wordmark. It
 * uses CSS custom properties so theme changes keep the brand color consistent.
 *
 * # Example
 * ```html
 * <app-weaklings-logo [compact]="true" />
 * ```
 */
@Component({
  selector: 'app-weaklings-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="brand" [class.brand--compact]="compact()" [class.brand--dense]="dense()" aria-label="WEAKLINGS">
      <svg viewBox="0 0 120 112" class="brand__mark" aria-hidden="true">
        <defs>
          <linearGradient [attr.id]="gradientId" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stop-color="#fecaca" />
            <stop offset="0.45" stop-color="#dc2626" />
            <stop offset="1" stop-color="#450a0a" />
          </linearGradient>
        </defs>
        <path class="brand__line" d="M60 8 110 78H10L60 8Z" />
        <path class="brand__line" d="M60 32 94 86H26L60 32Z" />
        <path class="brand__gem" [attr.fill]="'url(#' + gradientId + ')'" d="M60 42 88 72 74 104H46L32 72 60 42Z" />
        <path class="brand__facet" d="M60 42v62M32 72h56M60 42 46 104M60 42l14 62" />
        <circle cx="60" cy="82" r="3.5" fill="#fff" opacity="0.9" />
      </svg>
      @if (!compact()) {
        <div class="brand__text">
          <span class="brand__name">WEAKLINGS</span>
          <span class="brand__tagline">GO HARD!</span>
        </div>
      }
    </div>
  `,
  styles: `
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      color: var(--color-primary);
    }

    .brand--compact {
      gap: 0;
    }

    .brand--dense {
      gap: 0.5rem;
    }

    .brand--dense .brand__mark {
      width: 1.75rem;
      height: 1.75rem;
      filter: none;
    }

    .brand--dense .brand__name {
      font-family: var(--font-sans);
      font-size: 0.8125rem;
      font-weight: 510;
      letter-spacing: -0.012em;
    }

    .brand--dense .brand__tagline {
      display: none;
    }

    .brand__mark {
      width: 3rem;
      height: 3rem;
      overflow: visible;
      filter: drop-shadow(0 0 14px var(--color-logo-glow));
    }

    .brand__line,
    .brand__facet {
      fill: none;
      stroke: currentColor;
      stroke-width: 4;
      stroke-linejoin: round;
    }

    .brand__line {
      opacity: 0.9;
    }

    .brand__gem {
      stroke: currentColor;
      stroke-width: 3;
      stroke-linejoin: round;
    }

    .brand__facet {
      stroke-width: 1.5;
      opacity: 0.45;
    }

    .brand__text {
      display: grid;
      line-height: 1;
    }

    /* The wordmark is the one place the serif survives: it is the brand
       signature, kept alongside the red as the two things that stay
       recognisably Weaklings in an otherwise monochrome system. */
    .brand__name {
      color: var(--color-text);
      font-family: var(--font-wordmark);
      font-size: 1.0625rem;
      font-weight: 700;
      letter-spacing: 0.08em;
    }

    .brand__tagline {
      margin-top: 0.25rem;
      color: var(--color-primary);
      font-family: var(--font-mono);
      font-size: 0.625rem;
      font-weight: 500;
      letter-spacing: 0.22em;
    }
  `,
})
export class WeaklingsLogo {
  private static nextGradientId = 0;

  readonly compact = input(false);
  readonly dense = input(false);
  protected readonly gradientId = `weaklings-gem-${++WeaklingsLogo.nextGradientId}`;
}
