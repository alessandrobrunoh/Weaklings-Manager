import type { PermissionCatalogEntry } from '../../core/models/api.models';

export interface PermissionGroup {
  readonly resource: string;
  readonly keys: readonly string[];
}

/**
 * Groups permission keys by resource for the matrix headings.
 *
 * Prefers the catalog when the backend sent one; otherwise splits
 * `available_permissions` on the first dot.
 */
export function groupPermissions(
  catalog: readonly PermissionCatalogEntry[] | undefined,
  available: readonly string[],
): PermissionGroup[] {
  const entries =
    catalog && catalog.length > 0
      ? catalog
      : available.map((key) => {
          const dot = key.indexOf('.');
          return {
            key,
            resource: dot === -1 ? key : key.slice(0, dot),
            action: dot === -1 ? '' : key.slice(dot + 1),
          };
        });
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const keys = groups.get(entry.resource) ?? [];
    keys.push(entry.key);
    groups.set(entry.resource, keys);
  }
  return [...groups.entries()].map(([resource, keys]) => ({ resource, keys }));
}
