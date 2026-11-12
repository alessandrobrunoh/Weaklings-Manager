import type { BuildRole, BuildSummary, CompBuildEntry } from '../../core/models/api.models';
import { COMP_PARTY_SIZE } from './comp-parties';
import { mergeRoleMix, partyCount, roleMixOf, versionKey, type RoleCount } from './comps-list-model';

/** Longest composition name the UI lays out without truncating awkwardly. */
export const MAX_COMP_NAME_LENGTH = 80;

/** A build version the officer put in the composition and how many players use it. */
export interface AddedBuild {
  readonly build: BuildSummary;
  readonly quantity: number;
}

/** Adds `by` players of a build; a build already in the list gets its quantity raised, never a second row. */
export function addToComposition(
  list: readonly AddedBuild[],
  build: BuildSummary,
  by = 1,
): AddedBuild[] {
  const existing = list.find((entry) => entry.build.id === build.id);
  return existing
    ? list.map((entry) =>
        entry.build.id === build.id ? { ...entry, quantity: entry.quantity + by } : entry,
      )
    : [...list, { build, quantity: by }];
}

/** Sets a build's quantity; zero or less removes it. */
export function setQuantity(
  list: readonly AddedBuild[],
  buildId: number,
  quantity: number,
): AddedBuild[] {
  return quantity <= 0
    ? list.filter((entry) => entry.build.id !== buildId)
    : list.map((entry) => (entry.build.id === buildId ? { ...entry, quantity } : entry));
}

/** One build in more than one version inside the same composition. */
export interface VersionClash {
  readonly name: string;
  /** The versions present, ascending. */
  readonly versions: readonly number[];
}

/**
 * Builds that appear in the composition under several versions (for example v1 and v3 of the same
 * healer): usually a mistake, since versions of a build are meant to replace each other.
 */
export function versionClashes(
  entries: readonly Pick<CompBuildEntry, 'build'>[],
): VersionClash[] {
  const groups = new Map<string, { name: string; versions: Set<number> }>();
  for (const { build } of entries) {
    const key = versionKey(build);
    const group = groups.get(key) ?? { name: build.name, versions: new Set<number>() };
    group.versions.add(build.version);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.versions.size > 1)
    .map((group) => ({ name: group.name, versions: [...group.versions].sort((a, b) => a - b) }));
}

/** Added builds a variant's parent already contains: adding them raises the parent's count. */
export function overlapWithParent(
  added: readonly AddedBuild[],
  inherited: readonly Pick<CompBuildEntry, 'build_id' | 'quantity'>[],
): AddedBuild[] {
  const ids = new Set(inherited.map((entry) => entry.build_id));
  return added.filter((entry) => ids.has(entry.build.id));
}

/** What a composition amounts to so far, parent's builds included. */
export interface CompositionTotals {
  readonly players: number;
  readonly inheritedPlayers: number;
  readonly addedPlayers: number;
  readonly parties: number;
  /** Players in the last party when it is not full; 0 when every party is full or there are none. */
  readonly partialParty: number;
  readonly mix: readonly RoleCount[];
}

export function compositionTotals(
  inherited: readonly Pick<CompBuildEntry, 'build' | 'quantity'>[],
  added: readonly AddedBuild[],
): CompositionTotals {
  const inheritedPlayers = inherited.reduce((sum, entry) => sum + entry.quantity, 0);
  const addedPlayers = added.reduce((sum, entry) => sum + entry.quantity, 0);
  const players = inheritedPlayers + addedPlayers;
  return {
    players,
    inheritedPlayers,
    addedPlayers,
    parties: partyCount(players),
    partialParty: players % COMP_PARTY_SIZE,
    mix: mergeRoleMix(roleMixOf(inherited), roleMixOf(added)),
  };
}

export interface CompDraft {
  readonly name: string;
  readonly categoryId: number | null;
  /** The composition is a variant: it needs a parent. */
  readonly variant: boolean;
  readonly parentId: number | null;
  /** Builds the officer added (not counting the parent's). */
  readonly buildCount: number;
}

export type CompDraftError =
  | { readonly field: 'name'; readonly code: 'required' | 'tooLong' | 'taken' }
  | { readonly field: 'category' | 'parent' | 'builds'; readonly code: 'required' };

/** What blocks creating the composition, in the order the form reads. */
export function validateCompDraft(draft: CompDraft, existingNames: readonly string[]): CompDraftError[] {
  const errors: CompDraftError[] = [];
  const name = draft.name.trim();
  if (!name) {
    errors.push({ field: 'name', code: 'required' });
  } else if (name.length > MAX_COMP_NAME_LENGTH) {
    errors.push({ field: 'name', code: 'tooLong' });
  } else if (existingNames.some((existing) => existing.trim().toLowerCase() === name.toLowerCase())) {
    errors.push({ field: 'name', code: 'taken' });
  }
  if (draft.categoryId === null || draft.categoryId <= 0) {
    errors.push({ field: 'category', code: 'required' });
  }
  if (draft.variant && (draft.parentId === null || draft.parentId <= 0)) {
    errors.push({ field: 'parent', code: 'required' });
  }
  if (draft.buildCount === 0) {
    errors.push({ field: 'builds', code: 'required' });
  }
  return errors;
}

/** Roles in a mix as "4 Tank · 5 Healer", with the caller supplying the translated role name. */
export function roleMixText(mix: readonly RoleCount[], labelOf: (role: BuildRole) => string): string {
  return mix.map((entry) => `${entry.count} ${labelOf(entry.role)}`).join(' · ');
}
