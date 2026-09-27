/** Whether a comps/builds listing or picker shows only the current user's rows. */
export type OwnershipScope = 'mine' | 'all';

/** True when `value` is a valid ownership-scope id. */
export function isOwnershipScope(value: string): value is OwnershipScope {
  return value === 'mine' || value === 'all';
}

/** Query fields that restrict a comps/builds list to the current user's rows. */
export function ownershipListParams(scope: OwnershipScope): { mine?: true } {
  return scope === 'mine' ? { mine: true } : {};
}

/**
 * Option label for a picker. In the Everyone view, homonyms from different
 * creators stay distinguishable by appending the username.
 */
export function ownershipOptionLabel(
  name: string,
  createdBy: string,
  scope: OwnershipScope,
): string {
  return scope === 'all' && createdBy ? `${name} · ${createdBy}` : name;
}
