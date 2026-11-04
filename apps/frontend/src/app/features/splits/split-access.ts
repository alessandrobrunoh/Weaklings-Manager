import type { SplitSummary } from '../../core/models/api.models';

export function canActOnSplit(
  split: Pick<SplitSummary, 'created_by_id'>,
  currentUserId: number | undefined,
  hasGlobalPermission: boolean,
): boolean {
  return hasGlobalPermission || (currentUserId !== undefined && split.created_by_id === currentUserId);
}

export function actionablePendingSplits<
  T extends Pick<SplitSummary, 'created_by_id' | 'status' | 'archived_at' | 'origin_read_only'>,
>(
  splits: readonly T[],
  currentUserId: number | undefined,
  hasGlobalPermission: boolean,
  isAllianceTenant: boolean,
): T[] {
  return splits.filter(
    (split) =>
      !isAllianceTenant &&
      !split.origin_read_only &&
      split.status === 'pending' &&
      !split.archived_at &&
      canActOnSplit(split, currentUserId, hasGlobalPermission),
  );
}
