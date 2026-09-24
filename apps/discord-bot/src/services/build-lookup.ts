import type { BuildSummary } from '../api/types.js';

/** The public build key intentionally uses spaces, never hyphens. */
export function buildDisplayName(build: BuildSummary): string {
  return [build.name, build.category_name, build.created_by_username]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ');
}

/**
 * Matches the full public key first. Falling back to the build name keeps the
 * command convenient while still asking for the full key when variants collide.
 */
export function findBuildMatches(
  builds: readonly BuildSummary[],
  query: string,
): BuildSummary[] {
  const normalizedQuery = normalize(query);
  const exactLabelMatches = builds.filter(
    (build) => normalize(buildDisplayName(build)) === normalizedQuery,
  );
  if (exactLabelMatches.length > 0) return exactLabelMatches;

  return builds.filter((build) => normalize(build.name) === normalizedQuery);
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
