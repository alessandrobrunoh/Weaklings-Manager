/**
 * Shared page treatment for feature pages.
 *
 * Despite the historical name, this is the standard page shell every feature
 * page opts into: a block host that can shrink, one card style, hairline table
 * rows and a phone-width card treatment. Type sizes, label style and table
 * density come from the global stylesheet (`styles.css`) so there is exactly
 * one definition of each; this file only adds the host-level geometry.
 */
export const COMPACT_FEATURE_STYLES = `
  :host {
    display: block;
    min-width: 0;
  }

  :host .card,
  :host .surface,
  :host .auth-card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-cards);
    box-shadow: none;
  }

  :host .card:hover {
    box-shadow: none;
  }

  :host :where(form, section, article, fieldset) {
    min-width: 0;
  }

  :host :where(.input, .select, textarea) {
    border-radius: var(--radius-inputs);
  }

  :host :where(.btn) {
    border-radius: var(--radius-buttons);
  }

  :host :where(table) {
    border-collapse: collapse;
  }

  :host :where(td, th) {
    border-bottom: 1px solid var(--color-border);
  }

  :host :where(.auth-card) {
    background: var(--color-surface);
  }

  @media (max-width: 640px) {
    :host :where(.card, .auth-card) {
      border-inline: 0;
      border-radius: var(--radius-cards);
    }
  }
`;
