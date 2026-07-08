"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import { Balance, Transaction, acceptWithdrawal, getBalance, listTransactions, withdraw } from "@/services/bankService";

export default function Bank() {
  const { user, loading, can } = useAuth();
  const router = useRouter();
  const isOfficer = can("superadmin", "admin", "officer");

  const [balance, setBalance] = useState<Balance | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statusFilter, setStatusFilter] = useState<"pending" | "requested" | "withdrawn">("pending");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [balanceRes, txRes] = await Promise.all([
        getBalance(),
        listTransactions(1, 50, statusFilter),
      ]);
      setBalance(balanceRes);
      setTransactions(txRes.items);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load bank data");
    }
  }, [statusFilter]);

  useEffect(() => {
    if (user) {
      // Fetch-on-mount when auth resolves; refresh's first setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [user, refresh]);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading session...</p>
      </div>
    );
  }

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === transactions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(transactions.map((t) => t.id)));
    }
  };

  const withdrawSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      setError(null);
      await withdraw({ transactionIds: Array.from(selected) });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to withdraw transactions");
    } finally {
      setBusy(false);
    }
  };

  const withdrawAll = async () => {
    setBusy(true);
    try {
      setError(null);
      await withdraw({ all: true });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to withdraw transactions");
    } finally {
      setBusy(false);
    }
  };

  const acceptAllRequested = async () => {
    setBusy(true);
    try {
      setError(null);
      await acceptWithdrawal({ all: true });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to accept withdrawals");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8 space-y-6">
        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-2xl font-bold tracking-tight">Balances & Accounting</h2>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            View what the Guild Bank owes you and withdraw it whenever you&rsquo;re ready.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Pending balance</p>
              <p className="mt-1 text-3xl font-bold tracking-tight">
                {balance ? balance.pending_total : "0.00"}
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {balance ? balance.pending_count : 0} pending transaction(s)
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-900/50">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Requested (awaiting payout)</p>
              <p className="mt-1 text-3xl font-bold tracking-tight">
                {balance ? balance.requested_total : "0.00"}
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {balance ? balance.requested_count : 0} requested transaction(s)
              </p>
            </div>
          </div>

          {isOfficer && (
            <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900/30 dark:bg-indigo-950/20">
              <p className="text-sm text-indigo-800 dark:text-indigo-300">
                Officer: accept and pay out every currently-requested withdrawal guild-wide. You become the recorded payer.
              </p>
              <button
                onClick={acceptAllRequested}
                disabled={busy}
                className="rounded-full border border-indigo-600 bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40"
              >
                Accept all requested
              </button>
            </div>
          )}

          {error && (
            <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-2">
              <button
                onClick={() => setStatusFilter("pending")}
                className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                  statusFilter === "pending"
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-black"
                    : "border-zinc-200 bg-transparent text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                Pending
              </button>
              <button
                onClick={() => setStatusFilter("requested")}
                className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                  statusFilter === "requested"
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-black"
                    : "border-zinc-200 bg-transparent text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                Requested
              </button>
              <button
                onClick={() => setStatusFilter("withdrawn")}
                className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                  statusFilter === "withdrawn"
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-black"
                    : "border-zinc-200 bg-transparent text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                Withdrawn
              </button>
            </div>

            {statusFilter === "pending" && (
              <div className="flex gap-2">
                <button
                  onClick={withdrawSelected}
                  disabled={busy || selected.size === 0}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                >
                  Request selected
                </button>
                <button
                  onClick={withdrawAll}
                  disabled={busy || transactions.length === 0}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  Request all
                </button>
              </div>
            )}
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  {statusFilter === "pending" && (
                    <th className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={transactions.length > 0 && selected.size === transactions.length}
                        onChange={toggleSelectAll}
                      />
                    </th>
                  )}
                  <th className="py-2 pr-4">From</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Date</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-zinc-500 dark:text-zinc-400">
                      No transactions.
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id} className="border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30">
                      {statusFilter === "pending" && (
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            checked={selected.has(tx.id)}
                            onChange={() => toggleSelected(tx.id)}
                          />
                        </td>
                      )}
                      <td className="py-2 pr-4">{tx.from_label}</td>
                      <td className="py-2 pr-4 font-medium">{tx.amount}</td>
                      <td className="py-2 pr-4 capitalize">{tx.status}</td>
                      <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">
                        {new Date(tx.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
