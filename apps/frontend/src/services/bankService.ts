/**
 * A single transaction in the Guild Bank ledger.
 */
export interface Transaction {
  id: number;
  from_user_id: number | null;
  from_label: string;
  to_user_id: number;
  amount: string;
  status: "pending" | "requested" | "withdrawn";
  type: string;
  split_id: number | null;
  created_at: string;
  requested_at: string | null;
  withdrawn_at: string | null;
}

/**
 * A user's derived Guild Bank balance.
 */
export interface Balance {
  user_id: number;
  pending_total: string;
  pending_count: number;
  requested_total: string;
  requested_count: number;
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
 * Fetches the caller's derived pending balance.
 */
export async function getBalance(): Promise<Balance> {
  const res = await fetch("/api/bank/balance");
  return unwrap<Balance>(res);
}

/**
 * Lists the caller's transactions, paginated and optionally filtered by status.
 */
export async function listTransactions(
  page = 1,
  limit = 20,
  status?: "pending" | "requested" | "withdrawn"
): Promise<PaginatedResponse<Transaction>> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) params.set("status", status);
  const res = await fetch(`/api/bank/transactions?${params.toString()}`);
  return unwrap<PaginatedResponse<Transaction>>(res);
}

/**
 * Requests withdrawal of one, several, or all of the caller's pending transactions. Does not
 * pay them out — moves them to "requested" status, awaiting officer acceptance.
 */
export async function withdraw(input: { transactionIds?: number[]; all?: boolean }): Promise<Transaction[]> {
  const res = await fetch("/api/bank/transactions/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_ids: input.transactionIds, all: input.all }),
  });
  return unwrap<Transaction[]>(res);
}

/**
 * Accepts (and pays out) one, several, or all currently-requested withdrawals. The caller
 * (an officer/admin) becomes the recorded payer.
 */
export async function acceptWithdrawal(input: { transactionIds?: number[]; all?: boolean }): Promise<Transaction[]> {
  const res = await fetch("/api/bank/transactions/withdraw/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_ids: input.transactionIds, all: input.all }),
  });
  return unwrap<Transaction[]>(res);
}
