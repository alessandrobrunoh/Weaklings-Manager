/**
 * A participant's weight-based share within a split.
 */
export interface SplitParticipant {
  user_id: number;
  username: string;
  weight: number;
  share_amount: string | null;
}

/**
 * A split's summary, as shown in list views.
 */
export interface Split {
  id: number;
  created_by_username: string;
  status: "pending" | "completed" | "not_completed" | "lost";
  estimated_market_value: string;
  repair_value: string;
  bags_value: string;
  net_value: string | null;
  note: string | null;
  created_at: string;
  finalized_at: string | null;
  participant_count: number;
}

/**
 * A split's full detail, including participants.
 */
export interface SplitDetail extends Split {
  participants: SplitParticipant[];
}

/**
 * A candidate name that was successfully matched to a saved user account via that user's
 * linked Albion Online character name.
 */
export interface MatchedParticipant {
  user_id: number;
  username: string;
  matched_name: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
  const body = await res.json();
  return body.data as T;
}

/**
 * Lists all splits, paginated.
 */
export async function listSplits(page = 1, limit = 10): Promise<PaginatedResponse<Split>> {
  const res = await fetch(`/api/splits?page=${page}&limit=${limit}`);
  return unwrap<PaginatedResponse<Split>>(res);
}

/**
 * Fetches a single split's full detail.
 */
export async function getSplit(id: number): Promise<SplitDetail> {
  const res = await fetch(`/api/splits/${id}`);
  return unwrap<SplitDetail>(res);
}

/**
 * Requests a new split together with its participants. Starts in "pending" status.
 */
export async function createSplit(input: {
  estimatedMarketValue: number;
  repairValue: number;
  bagsValue: number;
  note?: string;
  participants: { userId: number; weight: number }[];
}): Promise<SplitDetail> {
  const res = await fetch("/api/splits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      estimated_market_value: input.estimatedMarketValue.toFixed(2),
      repair_value: input.repairValue.toFixed(2),
      bags_value: input.bagsValue.toFixed(2),
      note: input.note || null,
      participants: input.participants.map((p) => ({ user_id: p.userId, weight: p.weight })),
    }),
  });
  return unwrap<SplitDetail>(res);
}

/**
 * Adds a new participant to a pending split, or updates their weight if already present.
 */
export async function upsertParticipant(
  splitId: number,
  input: { userId: number; weight: number }
): Promise<SplitDetail> {
  const res = await fetch(`/api/splits/${splitId}/participants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: input.userId, weight: input.weight }),
  });
  return unwrap<SplitDetail>(res);
}

/**
 * Removes a participant from a pending split.
 */
export async function removeParticipant(splitId: number, userId: number): Promise<SplitDetail> {
  const res = await fetch(`/api/splits/${splitId}/participants/${userId}`, {
    method: "DELETE",
  });
  return unwrap<SplitDetail>(res);
}

/**
 * Completes a pending split, generating Guild Bank transactions for each participant.
 */
export async function completeSplit(splitId: number): Promise<SplitDetail> {
  const res = await fetch(`/api/splits/${splitId}/complete`, { method: "POST" });
  return unwrap<SplitDetail>(res);
}

/**
 * Marks a pending split as not completed. Terminal; no transactions are generated.
 */
export async function markSplitNotCompleted(splitId: number): Promise<SplitDetail> {
  const res = await fetch(`/api/splits/${splitId}/not-completed`, { method: "POST" });
  return unwrap<SplitDetail>(res);
}

/**
 * Marks a pending split as lost (loot never recovered). Terminal; no transactions are generated.
 */
export async function markSplitLost(splitId: number): Promise<SplitDetail> {
  const res = await fetch(`/api/splits/${splitId}/lost`, { method: "POST" });
  return unwrap<SplitDetail>(res);
}

/**
 * Matches raw candidate names (e.g. OCR'd from a screenshot) against known linked players.
 * Only names that resolve to an existing, saved user account are returned.
 */
export async function matchParticipants(names: string[]): Promise<MatchedParticipant[]> {
  const res = await fetch("/api/splits/match-participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  return unwrap<MatchedParticipant[]>(res);
}
