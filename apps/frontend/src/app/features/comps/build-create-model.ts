import type { BuildRole } from '../../core/models/api.models';
import { buildNeedsWeapon } from '../../shared/validation/build-validation';

/** Longest build name the UI lays out without truncating awkwardly. */
export const MAX_BUILD_NAME_LENGTH = 80;

export interface BuildCreateDraft {
  readonly name: string;
  readonly categoryId: number | null;
  readonly role: BuildRole;
  /** The main loadout has a main-hand weapon. */
  readonly hasWeapon: boolean;
}

export type BuildCreateError =
  | { readonly field: 'name'; readonly code: 'required' | 'tooLong' | 'taken' }
  | { readonly field: 'category' | 'weapon'; readonly code: 'required' };

/** The step a field belongs to, so "Next" only checks what the first step shows. */
export type BuildCreateStep = 'basics' | 'loadout';

export function stepOfField(field: BuildCreateError['field']): BuildCreateStep {
  return field === 'weapon' ? 'loadout' : 'basics';
}

/**
 * What blocks creating the build, in the order the steps read.
 *
 * A weapon is required unless the role is battle mount (a mount has no weapon to speak of), the same
 * rule the server applies.
 */
export function validateBuildCreate(
  draft: BuildCreateDraft,
  existingNames: readonly string[],
): BuildCreateError[] {
  const errors: BuildCreateError[] = [];
  const name = draft.name.trim();
  if (!name) {
    errors.push({ field: 'name', code: 'required' });
  } else if (name.length > MAX_BUILD_NAME_LENGTH) {
    errors.push({ field: 'name', code: 'tooLong' });
  } else if (existingNames.some((existing) => existing.trim().toLowerCase() === name.toLowerCase())) {
    errors.push({ field: 'name', code: 'taken' });
  }
  if (draft.categoryId === null || draft.categoryId <= 0) {
    errors.push({ field: 'category', code: 'required' });
  }
  if (buildNeedsWeapon(draft.role) && !draft.hasWeapon) {
    errors.push({ field: 'weapon', code: 'required' });
  }
  return errors;
}

/** What picking a build to copy does to the role field, and what the form should tell the officer. */
export interface CopyRolePlan {
  /** Role the draft ends up with. */
  readonly role: BuildRole;
  /**
   * `set` - the role was taken from the copied build because the officer had not chosen one;
   * `kept` - the officer's own choice stays although the copied build has another role;
   * `null` - nothing to say (same role, or nothing copied).
   */
  readonly note: 'set' | 'kept' | null;
}

/**
 * Decides the role after "copy from": an explicit choice of the officer is never overwritten, and a
 * role taken from the copied build is always announced.
 */
export function planCopyRole(input: {
  readonly current: BuildRole;
  readonly touched: boolean;
  readonly copied: BuildRole | null;
}): CopyRolePlan {
  if (input.copied === null || input.copied === input.current) {
    return { role: input.current, note: null };
  }
  return input.touched
    ? { role: input.current, note: 'kept' }
    : { role: input.copied, note: 'set' };
}
