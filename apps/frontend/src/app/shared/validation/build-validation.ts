/**
 * Validation for build and composition forms.
 *
 * Kept as pure functions rather than Angular validators so the rules can be
 * unit-tested on their own and reused by both the create dialog and the detail
 * editor, which previously disagreed: one checked a name was present, the other
 * checked nothing at all and silently ignored an emptied field.
 */

/** A field that failed validation, and why. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** Longest name the UI lays out without truncating awkwardly. */
const MAX_NAME_LENGTH = 80;

/** The slot a build is effectively defined by. */
const PRIMARY_SLOT = 'weapon';

/** What a build form holds at submit time. */
export interface BuildDraft {
  readonly name: string;
  readonly categoryId: number | null;
  readonly role: string;
  /** Slots the draft has an item for. */
  readonly filledSlots: readonly string[];
}

/** Context needed for checks that depend on what already exists. */
export interface BuildValidationContext {
  /** Names of existing builds, used for the duplicate check. */
  readonly existingNames: readonly string[];
  /** Name being edited, so a build does not collide with itself. */
  readonly currentName?: string;
  /** Whether the category must be chosen. False when editing keeps the old one. */
  readonly requireCategory?: boolean;
}

/**
 * Validates a build name.
 *
 * Emptiness is checked after trimming, because a name of spaces renders as a
 * blank row and is never what someone meant.
 */
export function validateBuildName(
  name: string,
  context: BuildValidationContext,
): FieldError | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return { field: 'name', message: 'Name is required.' };
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return {
      field: 'name',
      message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
    };
  }
  // Case-insensitive: "Bear Paws" and "bear paws" are the same build to a
  // human scanning a list, and the database has no unique index to catch it.
  const clash = context.existingNames.some(
    (existing) =>
      existing.trim().toLowerCase() === trimmed.toLowerCase() &&
      existing.trim().toLowerCase() !== (context.currentName ?? '').trim().toLowerCase(),
  );
  if (clash) {
    return { field: 'name', message: 'A build with that name already exists.' };
  }
  return null;
}

/**
 * Validates a whole build draft.
 *
 * A build with no weapon is rejected: the weapon is what the build *is*, and
 * one saved without it silently breaks role classification and comp costing
 * downstream. Other slots stay optional — half-specified builds are a normal
 * intermediate state while an officer is still assembling one.
 */
export function validateBuildDraft(
  draft: BuildDraft,
  context: BuildValidationContext,
): FieldError[] {
  const errors: FieldError[] = [];

  const nameError = validateBuildName(draft.name, context);
  if (nameError) {
    errors.push(nameError);
  }

  if ((context.requireCategory ?? true) && (!draft.categoryId || draft.categoryId <= 0)) {
    errors.push({ field: 'category', message: 'Category is required.' });
  }

  if (!draft.role.trim()) {
    errors.push({ field: 'role', message: 'Role is required.' });
  }

  if (!draft.filledSlots.includes(PRIMARY_SLOT)) {
    errors.push({
      field: 'items',
      message: 'A build needs a weapon — it is what determines its role and cost.',
    });
  }

  return errors;
}

/** Joins field errors into one line suitable for a toast. */
export function summarizeErrors(errors: readonly FieldError[]): string {
  return errors.map((error) => error.message).join(' ');
}
