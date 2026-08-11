import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'activity'
  | 'alert'
  | 'bank'
  | 'calendar'
  | 'chart'
  | 'check'
  | 'chevron-right'
  | 'close'
  | 'discord'
  | 'hammer'
  | 'info'
  | 'link'
  | 'menu'
  | 'moon'
  | 'package'
  | 'search'
  | 'settings'
  | 'shield'
  | 'sparkles'
  | 'sun'
  | 'swords'
  | 'users'
  | 'trophy';

/**
 * Inline SVG icon primitive for the app shell and feature cards.
 *
 * The project intentionally avoids a third-party icon package so the initial
 * bundle stays small and SSR-safe. Every icon uses `currentColor`, allowing
 * shadcn-like button/card variants to control color with CSS tokens.
 *
 * # Example
 * ```html
 * <app-icon name="calendar" class="h-4 w-4" />
 * ```
 */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.display]': "'inline-flex'",
    '[style.width]': 'size()',
    '[style.height]': 'size()',
    '[style.color]': 'color() || null',
    '[attr.aria-hidden]': "decorative() ? 'true' : null",
    '[attr.role]': "decorative() ? null : 'img'",
  },
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-full w-full"
    >
      @switch (name()) {
        @case ('activity') {
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        }
        @case ('alert') {
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        }
        @case ('bank') {
          <path d="m3 10 9-6 9 6" />
          <path d="M5 10h14" />
          <path d="M6 10v8" />
          <path d="M10 10v8" />
          <path d="M14 10v8" />
          <path d="M18 10v8" />
          <path d="M4 18h16" />
          <path d="M3 21h18" />
        }
        @case ('calendar') {
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M3 10h18" />
        }
        @case ('chart') {
          <path d="M3 3v18h18" />
          <path d="m7 15 4-4 3 3 5-7" />
        }
        @case ('check') {
          <path d="M20 6 9 17l-5-5" />
        }
        @case ('chevron-right') {
          <path d="m9 18 6-6-6-6" />
        }
        @case ('close') {
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        }
        @case ('discord') {
          <path d="M8 9.5a6 6 0 0 1 8 0" />
          <path d="M7.5 15.5c3 1.6 6 1.6 9 0" />
          <path d="M9 13h.01" />
          <path d="M15 13h.01" />
          <path d="M7 5.5c3.5-1.7 6.5-1.7 10 0" />
          <path
            d="M5.5 7.5C4 10.5 3.7 13.7 4.3 17c2.2 1.7 4.8 2.5 7.7 2.5s5.5-.8 7.7-2.5c.6-3.3.3-6.5-1.2-9.5"
          />
          <path d="m8 6-.7-2" />
          <path d="m16 6 .7-2" />
        }
        @case ('hammer') {
          <path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9" />
          <path d="m17.5 10.5 2-2a2.1 2.1 0 0 0 0-3l-1-1a2.1 2.1 0 0 0-3 0l-2 2" />
          <path d="m9 6 9 9" />
        }
        @case ('info') {
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        }
        @case ('link') {
          <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
          <path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" />
        }
        @case ('menu') {
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h16" />
        }
        @case ('moon') {
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        }
        @case ('package') {
          <path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z" />
          <path d="M12 11 4.5 6.8" />
          <path d="M12 11v9" />
          <path d="m12 11 7.5-4.2" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        }
        @case ('settings') {
          <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7A2 2 0 1 1 7.1 4.2l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1A1.7 1.7 0 0 0 21 10h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z"
          />
        }
        @case ('shield') {
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        }
        @case ('sparkles') {
          <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
          <path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
          <path d="m5 2 .8 2.2L8 5l-2.2.8L5 8l-.8-2.2L2 5l2.2-.8L5 2Z" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.9 4.9 1.4 1.4" />
          <path d="m17.7 17.7 1.4 1.4" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.3 17.7-1.4 1.4" />
          <path d="m19.1 4.9-1.4 1.4" />
        }
        @case ('swords') {
          <path d="m14.5 17.5 3 3 3-3-3-3" />
          <path d="M13 19 3 9V3h6l10 10" />
          <path d="m9 3 2 2" />
          <path d="M3 9l2-2" />
          <path d="m4 20 16-16" />
        }
        @case ('users') {
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
          <path d="M16 3.1a4 4 0 0 1 0 7.8" />
        }
        @case ('trophy') {
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
        }
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input<string>('1.25rem');
  readonly color = input<string>();
  readonly decorative = input<boolean>(true);
}
