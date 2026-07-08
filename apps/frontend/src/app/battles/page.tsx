"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import { listBattles, BattleSummary } from "@/services/battlesService";

export default function BattlesPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [battles, setBattles] = useState<BattleSummary[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async (page: number = currentPage) => {
    setBusy(true);
    try {
      setError(null);
      const res = await listBattles(page, 10);
      setBattles(res.items);
      setTotalPages(res.total_pages);
      setCurrentPage(res.current_page);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load battles");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      refresh();
    }
  }, [user, refresh]);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      refresh(newPage);
    }
  };

  const formatNumber = (num: number): string => {
    return num.toLocaleString("en-US");
  };

  const findWinner = (guilds: BattleSummary["guilds"]) => {
    return guilds.find((g) => g.winner);
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading session...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-50">
      <Header />

      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-extrabold tracking-tight">Guild Battles</h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Recent battles involving the Weaklings guild.
            </p>
          </div>
          <button
            onClick={() => refresh()}
            disabled={busy}
            className="text-xs font-semibold text-indigo-500 hover:underline disabled:opacity-40"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
            <p className="text-sm font-medium text-red-800 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="mt-8">
          {busy && battles.length === 0 ? (
            <div className="flex justify-center py-12">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading battles...</p>
            </div>
          ) : battles.length === 0 ? (
            <div className="rounded-3xl border border-zinc-200 border-dashed bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="text-lg font-bold">No battles found</h3>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Check back later for recent guild battles.
              </p>
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {battles.map((battle) => {
                const winner = findWinner(battle.guilds);
                const startDate = new Date(battle.start_time);
                return (
                  <Link
                    key={battle.battle_id}
                    href={`/battles/${battle.battle_id}`}
                    className="flex flex-col justify-between rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
                  >
                    <div>
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="text-xl font-bold tracking-tight">Battle #{battle.battle_id}</h3>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {startDate.toLocaleString()}
                          </p>
                        </div>
                        {winner && (
                          <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700 dark:bg-green-950/40 dark:text-green-400">
                            {winner.name} Won
                          </span>
                        )}
                      </div>

                      <div className="mt-4 grid grid-cols-3 gap-4 text-center">
                        <div>
                          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            Players
                          </p>
                          <p className="text-lg font-bold">{formatNumber(battle.total_players)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            Total Kills
                          </p>
                          <p className="text-lg font-bold">{formatNumber(battle.total_kills)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            Total Fame
                          </p>
                          <p className="text-lg font-bold">{formatNumber(battle.total_fame)}</p>
                        </div>
                      </div>

                      <div className="mt-4 space-y-2">
                        {battle.guilds.map((guild) => (
                          <div
                            key={guild.id}
                            className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs ${
                              guild.winner
                                ? "bg-green-50 dark:bg-green-950/20"
                                : "bg-zinc-50 dark:bg-zinc-900/40"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">{guild.name}</span>
                              {guild.winner && (
                                <span className="rounded-full bg-green-200 px-2 py-0.5 text-xs font-bold text-green-800 dark:bg-green-900 dark:text-green-200">
                                  WINNER
                                </span>
                              )}
                            </div>
                            <div className="flex gap-3 text-zinc-600 dark:text-zinc-400">
                              <span>{guild.players} players</span>
                              <span>{guild.kills} kills</span>
                              <span>{formatNumber(guild.kill_fame)} fame</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-4">
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1 || busy}
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Previous
              </button>
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages || busy}
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
