/**
 * Styles of the dense table both lists (compositions and builds) share.
 *
 * One stretched link per row makes the whole row a real link (keyboard operable, middle-click, right
 * click "open in new tab") without wrapping a table row in an anchor; the controls inside a row (the
 * versions toggle, the variant link, the overflow menu) sit above that link with `.lt-above`.
 *
 * Below ~44rem of container width the table turns into compact rows: the name and the menu on the
 * first line, the remaining facts wrapping underneath, and the header row is visually hidden (it
 * stays in the accessibility tree through explicit table roles in the templates).
 */
export const LIST_TABLE_STYLES = `
  :host {
    display: block;
    color: var(--color-text);
  }
  .lt {
    container-type: inline-size;
    container-name: lt;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .lt-table {
    width: 100%;
    border-collapse: collapse;
  }
  .lt-table th {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.75rem;
    font-weight: 500;
    text-align: start;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }
  .lt-table td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--color-border);
    vertical-align: middle;
    font-size: 0.8125rem;
    line-height: 1.25rem;
  }
  .lt-table tbody tr:first-child td {
    border-top: 0;
  }
  .lt-row {
    position: relative;
  }
  .lt-row:hover > td {
    background: var(--color-surface-hover);
  }
  .lt-row--older > td {
    background: var(--color-surface-2);
  }
  .lt-row--older:hover > td {
    background: var(--color-surface-hover);
  }
  .lt-num {
    text-align: end;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .lt-table th.lt-num {
    text-align: end;
  }
  .lt-muted {
    color: var(--color-text-secondary);
  }
  .lt-mono {
    font-family: var(--font-mono);
  }
  .lt-sort {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 1.5rem;
    margin: -0.25rem -0.375rem;
    padding: 0.25rem 0.375rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .lt-sort:hover,
  .lt-sort[data-active='true'] {
    color: var(--color-text);
  }
  .lt-sort:focus-visible,
  .lt-above:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .lt-sort__arrow {
    font-size: 0.75rem;
    line-height: 1;
  }
  .lt-name {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    min-width: 0;
  }
  .lt-name__text {
    min-width: 0;
  }
  .lt-link {
    color: var(--color-text);
    font-size: 0.875rem;
    font-weight: 500;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .lt-link::after {
    content: '';
    position: absolute;
    inset: 0;
  }
  .lt-link:hover {
    text-decoration: underline;
  }
  .lt-link:focus-visible {
    outline: none;
  }
  .lt-link:focus-visible::after {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    border-radius: var(--radius-sm);
  }
  .lt-above {
    position: relative;
    z-index: 1;
  }
  .lt-version {
    margin-inline-start: 0.375rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--color-text-secondary);
  }
  .lt-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 0.5rem;
    font-size: 0.75rem;
    line-height: 1.125rem;
    color: var(--color-text-secondary);
  }
  .lt-sub a {
    color: inherit;
    text-decoration: underline;
  }
  .lt-sub a:hover {
    color: var(--color-text);
  }
  .lt-versions {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 1.5rem;
    padding: 0 0.375rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .lt-versions:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
  .lt-versions__chevron {
    display: inline-flex;
    transition: transform var(--motion-fast);
  }
  .lt-versions[aria-expanded='true'] .lt-versions__chevron {
    transform: rotate(90deg);
  }
  .lt-actions {
    width: 1%;
    text-align: end;
    white-space: nowrap;
  }
  .lt-mobile-label {
    display: none;
  }
  .lt-c-updated {
    white-space: nowrap;
  }
  .lt-stack {
    display: block;
    font-size: 0.75rem;
  }
  .lt-empty-cell {
    color: var(--color-text-tertiary);
  }
  .lt-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-block-start: 0.75rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  /* ---- grouping header row (builds grouped by weapon) ----------------------------------------- */
  .lt-group td {
    padding-block: 0.375rem;
    background: var(--color-surface-2);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }
  .lt-group__title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* ---- loading skeleton ---------------------------------------------------------------------- */
  .lt-skel {
    display: block;
    height: 0.75rem;
    border-radius: var(--radius-sm);
    background: linear-gradient(
      90deg,
      var(--color-surface-2) 25%,
      var(--color-surface-3) 50%,
      var(--color-surface-2) 75%
    );
    background-size: 200% 100%;
    animation: lt-shimmer 1.4s linear infinite;
  }
  .lt-skel--icon {
    width: 1.75rem;
    height: 1.75rem;
  }
  @keyframes lt-shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lt-skel {
      animation: none;
    }
    .lt-versions__chevron {
      transition: none;
    }
  }

  /* ---- compact rows on narrow containers ------------------------------------------------------- */
  @container lt (max-width: 44rem) {
    .lt-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .lt-table,
    .lt-table tbody {
      display: block;
    }
    .lt-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.125rem 0.75rem;
      padding: 0.5rem 0.75rem;
      border-top: 1px solid var(--color-border);
    }
    .lt-table tbody tr:first-child {
      border-top: 0;
    }
    .lt-row > td {
      display: block;
      padding: 0;
      border: 0;
      background: transparent;
    }
    .lt-row:hover > td,
    .lt-row--older > td,
    .lt-row--older:hover > td {
      background: transparent;
    }
    .lt-row--older {
      background: var(--color-surface-2);
    }
    .lt-row:hover {
      background: var(--color-surface-hover);
    }
    .lt-row > .lt-c-name {
      flex: 1 1 calc(100% - 3.5rem);
      min-width: 0;
    }
    .lt-row > .lt-actions {
      order: -1;
      flex: 0 0 auto;
      width: auto;
      margin-inline-start: auto;
    }
    .lt-row > .lt-c-name {
      order: -2;
    }
    .lt-row > .lt-c-roles {
      flex: 1 1 100%;
      order: 5;
    }
    .lt-table .lt-row > .lt-c-updated,
    .lt-stack {
      display: none;
    }
    .lt-row > .lt-num {
      text-align: start;
    }
    .lt-mobile-label {
      display: inline;
      margin-inline-end: 0.25rem;
      color: var(--color-text-secondary);
    }
    .lt-group {
      display: block;
    }
    .lt-group td {
      display: block;
      padding: 0.375rem 0.75rem;
    }
    .lt-row--skeleton > td {
      width: 100%;
    }
  }
`;
