"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import { Transaction, listTransactions } from "@/services/bankService";
import {
  fetchLinkStatus,
  fetchGuildRoster,
  linkPlayer,
  unlinkPlayer,
  type AlbionLinkStatus,
  type AlbionGuildMember,
} from "@/services/albionService";
import {
  listMyBattles,
  BattleSummary,
} from "@/services/battlesService";

type ProfileTab = "transactions" | "albion" | "battles";

export default function ProfilePage() {
  const { user, loading, highestRole } = useAuth();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<ProfileTab>("transactions");

  // Transactions state
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  // Albion state
  const [linkStatus, setLinkStatus] = useState<AlbionLinkStatus | null>(null);
  const [roster, setRoster] = useState<AlbionGuildMember[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Battles state
  const [battles, setBattles] = useState<BattleSummary[]>([]);
  const [battlesBusy, setBattlesBusy] = useState(false);
  const [battlesError, setBattlesError] = useState<string | null>(null);
  const [battlesTotalPages, setBattlesTotalPages] = useState(0);
  const [battlesCurrentPage, setBattlesCurrentPage] = useState(1);
  const [needsLink, setNeedsLink] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const loadTransactions = useCallback(async () => {
    setTxBusy(true);
    setTxError(null);
    try {
      const res = await listTransactions(1, 100);
      setTransactions(res.items);
    } catch (e) {
      setTxError(e instanceof Error ? e.message : "Failed to load transactions");
    } finally {
      setTxBusy(false);
    }
  }, []);

  const loadAlbionStatus = useCallback(async () => {
    try {
      const status = await fetchLinkStatus();
      setLinkStatus(status);
    } catch {
      setLinkStatus(null);
    }
  }, []);

  const loadMyBattles = useCallback(async (page: number = 1) => {
    setBattlesBusy(true);
    setBattlesError(null);
    try {
      const res = await listMyBattles(page, 50);
      setBattles(res.items);
      setBattlesTotalPages(res.total_pages);
      setBattlesCurrentPage(res.current_page);
      setNeedsLink(false);
    } catch (e) {
      if (e instanceof Error && e.message === "NOT_LINKED") {
        setNeedsLink(true);
      } else {
        setBattlesError(e instanceof Error ? e.message : "Failed to load your battles");
      }
    } finally {
      setBattlesBusy(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadTransactions();
      loadAlbionStatus();
    }
  }, [user, loadTransactions, loadAlbionStatus]);

  useEffect(() => {
    if (user && activeTab === "battles") {
      loadMyBattles();
    }
  }, [user, activeTab, loadMyBattles]);

  // Albion Debounced Search
  useEffect(() => {
    if (!user || linkStatus?.linked || searchQuery.trim() === "") {
      setRoster([]);
      return;
    }
    const handle = setTimeout(() => {
      fetchGuildRoster(searchQuery)
        .then(setRoster)
        .catch(() => setRoster([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [user, linkStatus, searchQuery]);

  const handleLink = async (member: AlbionGuildMember) => {
    setLinkBusy(true);
    setLinkError(null);
    try {
      const status = await linkPlayer(member.id, member.name);
      setLinkStatus(status);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to link player");
    } finally {
      setLinkBusy(false);
    }
  };

  const handleUnlink = async () => {
    if (!confirm("Are you sure you want to unlink your Albion character?")) return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      await unlinkPlayer();
      setLinkStatus({ linked: false });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to unlink player");
    } finally {
      setLinkBusy(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading session...</p>
      </div>
    );
  }

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : "/assets/images/Discord-Symbol-Black.png";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-50">
      <Header />

      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8 space-y-8">
        {/* Profile Large Card */}
        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 flex flex-col md:flex-row items-center gap-6">
          <img
            src={avatarUrl}
            alt={user.username}
            className="h-24 w-24 rounded-full bg-zinc-150 border-4 border-zinc-100 dark:border-zinc-900 object-cover shadow-sm"
            referrerPolicy="no-referrer"
          />
          <div className="text-center md:text-left space-y-2 flex-1">
            <h2 className="text-3xl font-extrabold tracking-tight">{user.username}</h2>
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 text-xs">
              <span className="rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 px-3 py-1 font-semibold">
                {highestRole}
              </span>
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-900 text-zinc-500 px-3 py-1 font-medium">
                User ID: {user.user_id}
              </span>
              {user.email && (
                <span className="rounded-full bg-zinc-100 dark:bg-zinc-900 text-zinc-500 px-3 py-1 font-medium">
                  {user.email}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400">Discord Snowflake: {user.id}</p>
          </div>
        </div>

        {/* Tab Controls */}
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 space-y-6">
          <div className="border-b border-zinc-200 dark:border-zinc-800 pb-2">
            <div className="flex gap-4">
              <button
                onClick={() => setActiveTab("transactions")}
                className={`pb-2.5 text-sm font-semibold border-b-2 transition ${
                  activeTab === "transactions"
                    ? "border-zinc-950 text-zinc-950 dark:border-white dark:text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
                }`}
              >
                Transactions Ledger
              </button>
              <button
                onClick={() => setActiveTab("albion")}
                className={`pb-2.5 text-sm font-semibold border-b-2 transition ${
                  activeTab === "albion"
                    ? "border-zinc-950 text-zinc-950 dark:border-white dark:text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
                }`}
              >
                Albion Online Account
              </button>
              <button
                onClick={() => setActiveTab("battles")}
                className={`pb-2.5 text-sm font-semibold border-b-2 transition ${
                  activeTab === "battles"
                    ? "border-zinc-950 text-zinc-950 dark:border-white dark:text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
                }`}
              >
                My Battles
              </button>
            </div>
          </div>

          {/* Tab Contents */}
          <div>
            {activeTab === "transactions" && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold tracking-tight">Your Transaction Ledger</h3>
                  <button
                    onClick={loadTransactions}
                    disabled={txBusy}
                    className="text-xs font-semibold text-indigo-500 hover:underline disabled:opacity-40"
                  >
                    Refresh
                  </button>
                </div>

                {txError && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
                    <p className="text-sm font-medium text-red-800 dark:text-red-400">{txError}</p>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        <th className="py-2.5 pr-4">Type</th>
                        <th className="py-2.5 pr-4">From</th>
                        <th className="py-2.5 pr-4">Amount</th>
                        <th className="py-2.5 pr-4">Status</th>
                        <th className="py-2.5 pr-4">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txBusy && transactions.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-zinc-400">
                            Loading transactions...
                          </td>
                        </tr>
                      ) : transactions.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-zinc-400 italic">
                            No transactions found for your account.
                          </td>
                        </tr>
                      ) : (
                        transactions.map((tx) => {
                          let badgeClass = "";
                          switch (tx.status) {
                            case "pending":
                              badgeClass = "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-400";
                              break;
                            case "requested":
                              badgeClass = "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-400";
                              break;
                            case "withdrawn":
                              badgeClass = "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400";
                              break;
                          }

                          return (
                            <tr key={tx.id} className="border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30">
                              <td className="py-3 pr-4 font-semibold capitalize">{tx.type.replace(/_/g, " ")}</td>
                              <td className="py-3 pr-4 text-zinc-600 dark:text-zinc-300">{tx.from_label}</td>
                              <td className="py-3 pr-4 font-bold text-zinc-900 dark:text-white">{tx.amount} silver</td>
                              <td className="py-3 pr-4">
                                <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${badgeClass}`}>
                                  {tx.status}
                                </span>
                              </td>
                              <td className="py-3 pr-4 text-zinc-500">
                                {new Date(tx.created_at).toLocaleString()}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === "battles" && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-bold tracking-tight">Your Battle History</h3>
                  <button
                    onClick={() => loadMyBattles(battlesCurrentPage)}
                    disabled={battlesBusy}
                    className="text-xs font-semibold text-indigo-500 hover:underline disabled:opacity-40"
                  >
                    Refresh
                  </button>
                </div>

                {battlesError && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
                    <p className="text-sm font-medium text-red-800 dark:text-red-400">{battlesError}</p>
                  </div>
                )}

                {needsLink && (
                  <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
                    <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-4">
                      You need to link your Albion Online character first to view your battle history.
                    </p>
                    <button
                      onClick={() => setActiveTab("albion")}
                      className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 dark:border-white dark:bg-white dark:text-black"
                    >
                      Link Your Character
                    </button>
                  </div>
                )}

                {!needsLink && battles.length === 0 && !battlesBusy && (
                  <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-950">
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      No battles found for your character.
                    </p>
                  </div>
                )}

                {battlesBusy && battles.length === 0 ? (
                  <div className="flex justify-center py-12">
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading battles...</p>
                  </div>
                ) : !needsLink && battles.length > 0 ? (
                  <>
                    <div className="grid gap-4">
                      {battles.map((battle) => {
                        const winner = battle.guilds.find((g) => g.winner);
                        const startDate = new Date(battle.start_time);
                        return (
                          <div
                            key={battle.battle_id}
                            className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 transition cursor-pointer"
                            onClick={() => router.push(`/battles/${battle.battle_id}`)}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div>
                                <h4 className="font-bold text-lg">Battle #{battle.battle_id}</h4>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                  {startDate.toLocaleString()}
                                </p>
                              </div>
                              {winner && (
                                <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700 dark:bg-green-950/40 dark:text-green-400">
                                  {winner.name} Won
                                </span>
                              )}
                            </div>
                            <div className="grid grid-cols-3 gap-4 text-center text-sm">
                              <div>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">Players</p>
                                <p className="font-semibold">{battle.total_players.toLocaleString()}</p>
                              </div>
                              <div>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">Kills</p>
                                <p className="font-semibold">{battle.total_kills.toLocaleString()}</p>
                              </div>
                              <div>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">Fame</p>
                                <p className="font-semibold">{battle.total_fame.toLocaleString()}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {battlesTotalPages > 1 && (
                      <div className="mt-6 flex items-center justify-center gap-4">
                        <button
                          onClick={() => {
                            if (battlesCurrentPage > 1) loadMyBattles(battlesCurrentPage - 1);
                          }}
                          disabled={battlesCurrentPage <= 1 || battlesBusy}
                          className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                        >
                          Previous
                        </button>
                        <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                          Page {battlesCurrentPage} of {battlesTotalPages}
                        </span>
                        <button
                          onClick={() => {
                            if (battlesCurrentPage < battlesTotalPages) loadMyBattles(battlesCurrentPage + 1);
                          }}
                          disabled={battlesCurrentPage >= battlesTotalPages || battlesBusy}
                          className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {activeTab === "albion" && (
              <div className="space-y-4">
                <h3 className="text-lg font-bold tracking-tight">Albion Online Character Link</h3>
                <p className="text-sm text-zinc-500">
                  Link your guild character to link your in-game loot splits and bank account ledger automations.
                </p>

                {linkError && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
                    <p className="text-sm font-medium text-red-800 dark:text-red-400">{linkError}</p>
                  </div>
                )}

                {linkStatus?.linked ? (
                  <div className="rounded-2xl border border-zinc-200 p-6 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/30 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Status</p>
                      <p className="text-base font-semibold mt-1">
                        Currently linked as: <span className="text-indigo-500 font-bold">{linkStatus.albion_player_name}</span>
                      </p>
                    </div>
                    <button
                      onClick={handleUnlink}
                      disabled={linkBusy}
                      className="rounded-full border border-red-200 bg-transparent px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-950 hover:text-white dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/20 disabled:opacity-40"
                    >
                      {linkBusy ? "Unlinking..." : "Unlink Character"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4 pt-2">
                    <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
                      <p className="text-sm text-zinc-500">
                        You have not linked an Albion Online character yet.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-sm font-medium">Search Guild Roster</label>
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search your character name..."
                        className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                      />
                    </div>

                    {searchQuery.trim() !== "" && (
                      <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                          {roster.map((member) => (
                            <li key={member.id} className="flex items-center justify-between py-2.5">
                              <span className="text-sm font-semibold">{member.name}</span>
                              <button
                                onClick={() => handleLink(member)}
                                disabled={linkBusy}
                                className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-zinc-800 dark:border-white dark:bg-white dark:text-black"
                              >
                                Link character
                              </button>
                            </li>
                          ))}
                          {roster.length === 0 && (
                            <li className="py-2.5 text-sm text-zinc-500 italic">No character found in guild roster.</li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
