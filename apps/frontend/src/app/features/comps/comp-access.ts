/**
 * Mirrors the backend's author-or-manage rule for builds and comps: `edit` and `delete` only
 * apply to rows the caller authored, while `manage` applies to anyone's.
 */
export function canChangeAuthored(
  row: { readonly created_by_id: number } | null | undefined,
  currentUserId: number | undefined,
  hasOwnPermission: boolean,
  hasManagePermission: boolean,
): boolean {
  if (hasManagePermission) {
    return true;
  }
  return (
    hasOwnPermission &&
    row != null &&
    currentUserId !== undefined &&
    row.created_by_id === currentUserId
  );
}
