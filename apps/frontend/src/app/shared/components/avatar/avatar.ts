import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type AvatarShape = 'circle' | 'rounded';

const SIZE_MAP: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-7 w-7 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-xl',
  xl: 'h-20 w-20 text-2xl',
};

/**
 * Reusable user avatar component.
 *
 * Resolves Discord avatars from user IDs and avatar hashes, custom URLs,
 * Discord default avatars based on snowflake IDs, or falls back to
 * styled initials when no avatar is available or image loading fails.
 *
 * # Example
 * ```html
 * <app-avatar [userId]="user.id" [avatar]="user.avatar" [username]="user.username" size="sm" />
 * ```
 */
@Component({
  selector: 'app-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex shrink-0',
  },
  template: `
    <span
      class="relative inline-flex shrink-0 items-center justify-center overflow-hidden select-none border transition-colors"
      [class]="containerClasses()"
      [style]="customStyles()"
      [attr.aria-label]="showImage() ? null : ariaLabel()"
    >
      @if (showImage()) {
        <img
          [src]="avatarUrl()"
          [alt]="ariaLabel()"
          (error)="onImageError()"
          class="h-full w-full object-cover select-none pointer-events-none"
          loading="lazy"
        />
      } @else {
        <span class="leading-none select-none font-semibold uppercase">{{ initials() }}</span>
      }
    </span>
  `,
})
export class Avatar {
  /** Discord snowflake ID or internal user ID. */
  readonly userId = input<string | number | null | undefined>(null);

  /** Discord avatar hash or full HTTP(S) image URL. */
  readonly avatar = input<string | null | undefined>(null);

  /** Display username used for fallback initials and aria/alt text. */
  readonly username = input<string>('');

  /** Preset size ('xs', 'sm', 'md', 'lg', 'xl') or custom dimension string. */
  readonly size = input<AvatarSize | string>('md');

  /** Corner shape: 'circle' (pill/circle) or 'rounded' (squircle). */
  readonly shape = input<AvatarShape>('circle');

  /** Tracks failed image URLs to cleanly fall back to initials. */
  private readonly failedUrl = signal<string | null>(null);

  /** Computed Discord avatar URL, default embed avatar, or null. */
  protected readonly avatarUrl = computed<string | null>(() => {
    const avatar = this.avatar()?.trim();
    const userId = this.userId();

    if (avatar) {
      if (avatar.startsWith('http://') || avatar.startsWith('https://')) {
        return avatar;
      }
      if (userId != null && String(userId).trim() !== '') {
        const uid = String(userId).trim();
        const ext = avatar.startsWith('a_') ? 'gif' : 'webp';
        return `https://cdn.discordapp.com/avatars/${uid}/${avatar}.${ext}?size=128`;
      }
    }

    if (userId != null) {
      const uidStr = String(userId).trim();
      // Discord snowflake is a positive integer > 10 digits
      if (/^\d{11,}$/.test(uidStr)) {
        try {
          const snowflake = BigInt(uidStr);
          const index = Number((snowflake >> 22n) % 6n);
          const safeIndex = ((index % 6) + 6) % 6;
          return `https://cdn.discordapp.com/embed/avatars/${safeIndex}.png`;
        } catch {
          return null;
        }
      }
    }

    return null;
  });

  /** Whether the image should be rendered. */
  protected readonly showImage = computed(() => {
    const url = this.avatarUrl();
    return Boolean(url && this.failedUrl() !== url);
  });

  /** User initials calculated from username. */
  protected readonly initials = computed<string>(() => {
    const name = this.username()?.trim();
    if (!name) {
      return '?';
    }
    const parts = name.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  });

  /** Accessibility label for avatar image and container. */
  protected readonly ariaLabel = computed(() => {
    const name = this.username()?.trim();
    return name ? `${name}'s avatar` : 'User avatar';
  });

  /** CSS classes applied to the inner avatar container. */
  protected readonly containerClasses = computed(() => {
    const s = this.size();
    const shape = this.shape();

    const sizeClass =
      (SIZE_MAP as Record<string, string>)[s] ??
      (s.startsWith('h-') || s.startsWith('w-') ? s : '');

    const shapeClass =
      shape === 'rounded'
        ? s === 'lg' || s === 'xl'
          ? 'rounded-2xl'
          : 'rounded-xl'
        : 'rounded-full';

    return `${sizeClass} ${shapeClass}`.trim();
  });

  /** Custom dimension inline styles if custom CSS length passed to size. */
  protected readonly customStyles = computed(() => {
    const s = this.size();
    const base =
      'background-color: var(--color-surface-2); color: var(--color-text); border-color: var(--color-border);';
    if (/^\d+(\.\d+)?(px|rem|em|%|vh|vw)$/.test(s)) {
      return `${base} width: ${s}; height: ${s};`;
    }
    return base;
  });

  /** Handles image loading errors by falling back to initials. */
  protected onImageError(): void {
    this.failedUrl.set(this.avatarUrl());
  }
}
