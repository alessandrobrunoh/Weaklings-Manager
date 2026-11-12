/**
 * Shared layout for the public auth and onboarding pages (login, server choice, no-server list,
 * blocked, registration). Every page is the same centred card at one width: brand mark and
 * product name, one page title, one line of helper text, the content, and one footer row of
 * actions with a single primary button.
 *
 * These rules replace the global `.auth-shell` / `.auth-card` marketing treatment in styles.css
 * (gradient ground, display-font uppercase title, large shadow). Component styles are unlayered,
 * so they win over that layered block without touching it.
 */
export const AUTH_LAYOUT_STYLES = `
  :host {
    display: block;
    min-width: 0;
  }

  :host .auth-page {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    min-height: 100dvh;
    padding: 1rem;
    background: var(--color-bg);
  }

  :host .auth-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    width: 100%;
    max-width: 28rem;
    margin: 0 auto;
  }

  :host .auth-main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-block: 1.5rem;
  }

  :host .auth-card {
    box-sizing: border-box;
    width: 100%;
    max-width: 28rem;
    margin: 0 auto;
    padding: 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-cards);
    background: var(--color-surface);
    box-shadow: none;
  }

  :host .auth-head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    text-align: center;
  }

  :host .auth-brand {
    margin: 0.5rem 0 0;
    font-size: var(--ui-text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  :host .auth-title {
    margin: 0;
    font-size: var(--ui-text-xl);
    font-weight: 600;
    line-height: 1.3;
    color: var(--color-text-heading);
  }

  :host .auth-hint {
    margin: 0;
    font-size: var(--ui-text-md);
    line-height: 1.5;
    color: var(--color-text-secondary);
  }

  :host .auth-stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  :host .auth-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  :host .auth-required {
    color: var(--color-error);
  }

  :host .auth-meta {
    margin: 0;
    font-size: var(--ui-text-sm);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  :host .auth-alert {
    margin: 0;
    font-size: var(--ui-text-md);
    line-height: 1.5;
    color: var(--color-error);
  }

  :host .auth-alert--neutral {
    color: var(--color-text-secondary);
  }

  :host .auth-foot {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  :host .auth-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  :host .auth-actions > .btn--primary {
    margin-left: auto;
  }

  :host .auth-actions > .btn {
    min-width: 6rem;
  }

  :host .auth-choices {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  :host .auth-choice {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 2.5rem;
    font-size: var(--ui-text-md);
    cursor: pointer;
  }

  :host .auth-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-inputs);
    overflow: hidden;
  }

  :host .auth-list > li + li {
    border-top: 1px solid var(--color-border);
  }

  :host .auth-list--scroll {
    max-height: 14rem;
    overflow-y: auto;
  }

  :host .auth-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 0;
    background: transparent;
    color: var(--color-text-heading);
    font: inherit;
    font-size: var(--ui-text-md);
    text-align: left;
    cursor: pointer;
  }

  :host .auth-row:hover:not(:disabled) {
    background: var(--color-surface-2);
  }

  :host .auth-row:disabled {
    cursor: default;
    opacity: 0.6;
  }

  :host .auth-row[aria-pressed='true'] {
    background: var(--color-surface-2);
    box-shadow: inset 3px 0 0 var(--color-primary);
  }

  :host .auth-row:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -2px;
  }

  :host .auth-row__name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :host .auth-row__meta {
    flex: none;
    font-size: var(--ui-text-xs);
    color: var(--color-text-secondary);
  }

  :host .auth-row__icon {
    flex: none;
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
  }

  :host .auth-row__chevron {
    flex: none;
    color: var(--color-text-secondary);
  }

  :host .auth-steps {
    margin-bottom: 1.25rem;
  }

  :host .auth-steps__label {
    margin: 0;
    font-size: var(--ui-text-xs);
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  :host .auth-steps__bar {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.25rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }

  :host .auth-steps__segment {
    height: 0.25rem;
    border-radius: 999px;
    background: var(--color-border);
  }

  :host .auth-steps__segment--reached {
    background: var(--color-primary);
  }

  :host .auth-review {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    font-size: var(--ui-text-md);
  }

  :host .auth-review dt {
    font-size: var(--ui-text-xs);
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  :host .auth-review dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  :host .auth-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border-radius: 999px;
    background: var(--color-error-container);
    color: var(--color-error);
  }

  @media (max-width: 26rem) {
    :host .auth-card {
      padding: 1.25rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :host .auth-row {
      transition: none;
    }
  }
`;
