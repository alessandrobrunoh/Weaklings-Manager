"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, use } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import { getBattle, BattleDetail, BattlePlayer } from "@/services/battlesService";

export default function BattleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const unwrappedParams = use(params);
  const battleId = Number(unwrappedParams.id);

  const [battle, setBattle] = useState<BattleDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredPlayers, setFilteredPlayers] = useState<BattlePlayer[]>([]);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const res = await getBattle(battleId);
      setBattle(res);
      setFilteredPlayers(res.players);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load battle details");
    } finally {
      setBusy(false);
    }
  }, [battleId]);

  useEffect(() => {
    if (user) {
      refresh();
    }
  }, [user, refresh]);

  // Debounced search for players
  useEffect(() => {
    if (!battle) return;
    const handler = setTimeout(() => {
      if (searchQuery.trim() === "") {
        setFilteredPlayers(battle.players);
      } else {
        const query = searchQuery.toLowerCase();
        const filtered = battle.players.filter((p) =>
          p.name.toLowerCase().includes(query)
        );
        setFilteredPlayers(filtered);
      }
    }, 200);
    return () => clearTimeout(handler);
  }, [searchQuery, battle]);

  const formatNumber = (num: number): string => {
    return num.toLocaleString("en-US");
  };

  const calculateDuration = (start: string, end: string): string => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) {
      return `${diffMins}m`;
    }
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
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

      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8 space-y-6">
        {/* Header Card */}
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-4">
                <h2 className="text-3xl font-extrabold tracking-tight">Battle #{battleId}</h2>
                <Link
                  href="/battles"
                  className="text-sm font-semibold text-indigo-500 hover:underline"
                >
                  ← Back to Battles
                </Link>
              </div>
              {battle && (
                <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-6 text-sm">
                  <div>
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Start Time</p>
                    <p className="font-semibold">{new Date(battle.start_time).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">End Time</p>
                    <p className="font-semibold">{new Date(battle.end_time).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Duration</p>
                    <p className="font-semibold">{calculateDuration(battle.start_time, battle.end_time)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Total Players</p>
                    <p className="font-semibold">{formatNumber(battle.total_players)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Total Fame</p>
                    <p className="font-semibold">{formatNumber(battle.total_fame)}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
            <p className="text-sm font-medium text-red-800 dark:text-red-400">{error}</p>
          </div>
        )}

        {busy && !battle && (
          <div className="flex justify-center py-12">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading battle details...</p>
          </div>
        )}

        {battle && (
          <>
            {/* Guilds Section */}
            <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 space-y-4">
              <h3 className="text-lg font-bold tracking-tight">Guilds</h3>
              <div className="grid gap-4 md:grid-cols-2">
                {battle.guilds
                  .sort((a, b) => (b.winner ? 1 : 0) - (a.winner ? 1 : 0))
                  .map((guild) => (
                    <div
                      key={guild.id}
                      className={`rounded-2xl border p-4 ${
                        guild.winner
                          ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/20"
                          : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold">{guild.name}</h4>
                          {guild.winner && (
                            <span className="rounded-full bg-green-200 px-2.5 py-1 text-xs font-bold text-green-800 dark:bg-green-900 dark:text-green-200">
                              WINNER
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            Players
                          </p>
                          <p className="font-semibold">{guild.players}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            Kills / Deaths
                          </p>
                          <p className="font-semibold">
                            {guild.kills} / {guild.deaths}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            Kill Fame
                          </p>
                          <p className="font-semibold">{formatNumber(guild.kill_fame)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            {/* Players Table */}
            <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold tracking-tight">Players</h3>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search players..."
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white w-64"
                />
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                      <th className="py-2.5 pr-4">Name</th>
                      <th className="py-2.5 pr-4">Guild</th>
                      <th className="py-2.5 pr-4">Kills</th>
                      <th className="py-2.5 pr-4">Deaths</th>
                      <th className="py-2.5 pr-4">Kill Fame</th>
                      <th className="py-2.5 pr-4">Death Fame</th>
                      <th className="py-2.5 pr-4">Item Power</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPlayers.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-zinc-400 italic">
                          No players found.
                        </td>
                      </tr>
                    ) : (
                      filteredPlayers
                        .sort((a, b) => b.kill_fame - a.kill_fame)
                        .map((player) => (
                          <tr
                            key={player.id}
                            className="border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30"
                          >
                            <td className="py-3 pr-4 font-semibold">{player.name}</td>
                            <td className="py-3 pr-4 text-zinc-600 dark:text-zinc-300">
                              {player.guild_name}
                            </td>
                            <td className="py-3 pr-4 font-semibold">{player.kills}</td>
                            <td className="py-3 pr-4 text-zinc-600 dark:text-zinc-300">{player.deaths}</td>
                            <td className="py-3 pr-4 font-bold text-zinc-900 dark:text-white">
                              {formatNumber(player.kill_fame)}
                            </td>
                            <td className="py-3 pr-4 text-zinc-600 dark:text-zinc-300">
                              {formatNumber(player.death_fame)}
                            </td>
                            <td className="py-3 pr-4 font-semibold text-zinc-900 dark:text-white">
                              {Math.round(player.item_power)}
                            </td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Kills Timeline */}
            <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 space-y-4">
              <h3 className="text-lg font-bold tracking-tight">Kills Timeline</h3>
              <div className="space-y-3">
                {battle.kills.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 italic">No kill events recorded.</p>
                ) : (
                  battle.kills.map((kill) => (
                    <div
                      key={kill.event_id}
                      className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40"
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-zinc-500 dark:text-zinc-400 min-w-[120px]">
                          {new Date(kill.time).toLocaleString()}
                        </span>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-green-700 dark:text-green-400">
                              {kill.killer.name}
                            </span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              [{kill.killer.guild_name || "No guild"}]
                            </span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              IP: {Math.round(kill.killer_item_power)}
                            </span>
                          </div>
                          <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                            killed
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-red-700 dark:text-red-400">
                              {kill.victim.name}
                            </span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              [{kill.victim.guild_name || "No guild"}]
                            </span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              IP: {Math.round(kill.victim_item_power)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="text-sm font-bold text-zinc-900 dark:text-white">
                        {formatNumber(kill.total_kill_fame)} fame
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
