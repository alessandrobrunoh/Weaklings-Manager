/** Builds (or comps) belonging to one creator, already ordered by name. */
export interface CreatorGroup<T> {
  readonly creator: string;
  readonly items: T[];
}

/**
 * Groups list rows by `created_by_username`, then by name.
 *
 * Homonyms from different creators all stay visible: each creator is a section,
 * and two "Heavy Mace" rows are not collapsed. Creator order is stable
 * alphabetical; within a section, name then id.
 */
export function groupBuildsByCreator<
  T extends { created_by_username: string; name: string; id: number },
>(builds: readonly T[]): CreatorGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const build of builds) {
    const existing = buckets.get(build.created_by_username);
    if (existing) {
      existing.push(build);
    } else {
      buckets.set(build.created_by_username, [build]);
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([creator, items]) => ({
      creator,
      items: [...items].sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id),
    }));
}
