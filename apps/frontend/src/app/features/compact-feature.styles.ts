/**
 * Local workbench treatment for the control-plane and entry-point features.
 *
 * This intentionally lives with the feature pages rather than in the global
 * stylesheet: the member-facing areas are being migrated independently and
 * should not inherit control-plane density by accident.
 */
export const COMPACT_FEATURE_STYLES = `
  :host {
    --radius-cards: 6px;
    --radius-panels: 6px;
    --radius-smallcards: 4px;
    --radius-inputs: 4px;
    --radius-buttons: 4px;
    --radius-badges: 3px;
    --card-padding: 0.875rem;
    --page-gap: 0.875rem;
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

  :host :where(.label, legend) {
    letter-spacing: 0.045em;
    text-transform: uppercase;
    font-size: 0.6875rem;
  }

  :host :where(table) {
    border-collapse: collapse;
  }

  :host :where(th) {
    font-size: 0.6875rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
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
      border-radius: 0;
    }
  }
`;
