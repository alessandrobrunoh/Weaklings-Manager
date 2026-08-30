import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Vertical rhythm under a page header.
 *
 * Replaces ad-hoc `mt-4` / `mb-6` between sections so every feature stacks
 * with the same 1.5rem gap.
 */
@Component({
  selector: 'app-page-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />`,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--page-gap);
    }
  `,
})
export class PageStack {}
