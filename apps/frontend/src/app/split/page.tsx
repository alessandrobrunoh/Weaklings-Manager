"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import {
  Split,
  SplitDetail,
  completeSplit,
  createSplit,
  getSplit,
  listSplits,
  markSplitLost,
  markSplitNotCompleted,
  matchParticipants,
  removeParticipant,
  upsertParticipant,
} from "@/services/splitService";
import { UserProfile, listUsers } from "@/services/userService";
import { ocrImage } from "@/services/ocrService";

interface DraftParticipant {
  userId: string;
  weight: string;
}

export default function SplitPage() {
  const { user, loading, can } = useAuth();
  const router = useRouter();
  const isOfficer = can("superadmin", "admin", "officer");

  const [splits, setSplits] = useState<Split[]>([]);
  const [expanded, setExpanded] = useState<SplitDetail | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [marketValue, setMarketValue] = useState("");
  const [repairValue, setRepairValue] = useState("");
  const [bagsValue, setBagsValue] = useState("");
  const [note, setNote] = useState("");
  const [draftParticipants, setDraftParticipants] = useState<DraftParticipant[]>([
    { userId: "", weight: "1" },
  ]);

  const [participantUserId, setParticipantUserId] = useState("");
  const [participantWeight, setParticipantWeight] = useState("1");

  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refreshSplits = useCallback(async () => {
    try {
      setError(null);
      const res = await listSplits(1, 20);
      setSplits(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load splits");
    }
  }, []);

  useEffect(() => {
    if (user) {
      // Fetch-on-mount when auth resolves; refreshSplits's first setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refreshSplits();
    }
  }, [user, refreshSplits]);

  useEffect(() => {
    if (user) {
      listUsers().then((res) => setUsers(res.items)).catch(() => setUsers([]));
    }
  }, [user]);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading session...</p>
      </div>
    );
  }

  const openSplit = async (id: number) => {
    try {
      setError(null);
      const detail = await getSplit(id);
      setExpanded(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load split");
    }
  };

  const updateDraftParticipant = (index: number, field: keyof DraftParticipant, value: string) => {
    setDraftParticipants((prev) =>
      prev.map((p, i) => (i === index ? { ...p, [field]: value } : p))
    );
  };

  const addDraftParticipantRow = () => {
    setDraftParticipants((prev) => [...prev, { userId: "", weight: "1" }]);
  };

  const removeDraftParticipantRow = (index: number) => {
    setDraftParticipants((prev) => prev.filter((_, i) => i !== index));
  };

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setOcrBusy(true);
    setOcrStatus(null);
    try {
      setError(null);
      const { lines } = await ocrImage(file);
      const matched = await matchParticipants(lines);

      setDraftParticipants((prev) => {
        const existingIds = new Set(prev.filter((p) => p.userId !== "").map((p) => p.userId));
        const additions = matched
          .filter((m) => !existingIds.has(String(m.user_id)))
          .map((m) => ({ userId: String(m.user_id), weight: "1" }));

        if (additions.length === 0) return prev;

        const base = prev.filter((p) => p.userId !== "");
        return [...base, ...additions];
      });

      setOcrStatus(
        matched.length > 0
          ? `Found ${lines.length} line(s) in screenshot, matched ${matched.length} known player(s).`
          : `Found ${lines.length} line(s) in screenshot, but none matched a known linked player.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to process screenshot");
    } finally {
      setOcrBusy(false);
    }
  };

  const handleCreateSplit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setError(null);
      const participants = draftParticipants
        .filter((p) => p.userId !== "")
        .map((p) => ({ userId: Number(p.userId), weight: Number(p.weight) || 1 }));

      if (participants.length === 0) {
        setError("Select at least one participant");
        setBusy(false);
        return;
      }

      const detail = await createSplit({
        estimatedMarketValue: Number(marketValue) || 0,
        repairValue: Number(repairValue) || 0,
        bagsValue: Number(bagsValue) || 0,
        note: note || undefined,
        participants,
      });
      setMarketValue("");
      setRepairValue("");
      setBagsValue("");
      setNote("");
      setDraftParticipants([{ userId: "", weight: "1" }]);
      await refreshSplits();
      setExpanded(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to request split");
    } finally {
      setBusy(false);
    }
  };

  const handleAddParticipant = async (e: FormEvent) => {
    e.preventDefault();
    if (!expanded) return;
    setBusy(true);
    try {
      setError(null);
      const detail = await upsertParticipant(expanded.id, {
        userId: Number(participantUserId),
        weight: Number(participantWeight) || 1,
      });
      setExpanded(detail);
      setParticipantUserId("");
      setParticipantWeight("1");
      await refreshSplits();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add participant");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveParticipant = async (userId: number) => {
    if (!expanded) return;
    setBusy(true);
    try {
      setError(null);
      const detail = await removeParticipant(expanded.id, userId);
      setExpanded(detail);
      await refreshSplits();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove participant");
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = async () => {
    if (!expanded) return;
    setBusy(true);
    try {
      setError(null);
      const detail = await completeSplit(expanded.id);
      setExpanded(detail);
      await refreshSplits();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to complete split");
    } finally {
      setBusy(false);
    }
  };

  const handleNotCompleted = async () => {
    if (!expanded) return;
    setBusy(true);
    try {
      setError(null);
      const detail = await markSplitNotCompleted(expanded.id);
      setExpanded(detail);
      await refreshSplits();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark split as not completed");
    } finally {
      setBusy(false);
    }
  };

  const handleLost = async () => {
    if (!expanded) return;
    setBusy(true);
    try {
      setError(null);
      const detail = await markSplitLost(expanded.id);
      setExpanded(detail);
      await refreshSplits();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark split as lost");
    } finally {
      setBusy(false);
    }
  };

  const totalWeight = expanded?.participants.reduce((sum, p) => sum + p.weight, 0) ?? 0;
  const previewNet =
    (Number(marketValue) || 0) - (Number(repairValue) || 0) + (Number(bagsValue) || 0);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8 space-y-6">
        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-2xl font-bold tracking-tight">Split Workspace</h2>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Request loot splits with their participants, and let an officer close them out.
          </p>
          {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <h3 className="text-lg font-semibold">Request a split</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Anyone can request a split, together with who should be paid. It starts as &quot;pending&quot;
              until an officer completes it, marks it not completed, or marks it lost.
            </p>
            <form onSubmit={handleCreateSplit} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Estimated market value
                <input
                  type="number"
                  step="0.01"
                  value={marketValue}
                  onChange={(e) => setMarketValue(e.target.value)}
                  className="rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                  required
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Repair value
                <input
                  type="number"
                  step="0.01"
                  value={repairValue}
                  onChange={(e) => setRepairValue(e.target.value)}
                  className="rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Bags value
                <input
                  type="number"
                  step="0.01"
                  value={bagsValue}
                  onChange={(e) => setBagsValue(e.target.value)}
                  className="rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Note
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                  placeholder="e.g. boss/item name"
                />
              </label>

              <div className="sm:col-span-2">
                <p className="text-sm font-medium">Participants</p>
                <div className="mt-2 flex flex-col gap-1">
                  <label className="flex flex-col gap-1 text-sm">
                    Import from screenshot
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleScreenshotUpload}
                      disabled={ocrBusy}
                      className="text-sm"
                    />
                  </label>
                  {ocrBusy && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Reading screenshot…</p>
                  )}
                  {ocrStatus && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{ocrStatus}</p>
                  )}
                </div>
                <div className="mt-2 space-y-2">
                  {draftParticipants.map((p, i) => (
                    <div key={i} className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1 text-sm">
                        User
                        <select
                          value={p.userId}
                          onChange={(e) => updateDraftParticipant(i, "userId", e.target.value)}
                          className="rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                        >
                          <option value="">Select a user</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.username}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        Weight
                        <input
                          type="number"
                          min={1}
                          value={p.weight}
                          onChange={(e) => updateDraftParticipant(i, "weight", e.target.value)}
                          className="w-24 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                        />
                      </label>
                      {draftParticipants.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeDraftParticipantRow(i)}
                          className="text-xs text-red-600 hover:underline dark:text-red-400"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addDraftParticipantRow}
                  className="mt-2 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  + Add participant
                </button>
              </div>

              <p className="sm:col-span-2 text-sm text-zinc-500 dark:text-zinc-400">
                Net value preview: {previewNet.toFixed(2)}
              </p>
              <button
                type="submit"
                disabled={busy}
                className="sm:col-span-2 rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
              >
                Request split
              </button>
            </form>
        </div>

        {expanded && (
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                Split #{expanded.id} {expanded.note ? `— ${expanded.note}` : ""}
              </h3>
              <button
                onClick={() => setExpanded(null)}
                className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
              >
                Close
              </button>
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Status: <span className="capitalize">{expanded.status.replace("_", " ")}</span> · Net value:{" "}
              {expanded.net_value ?? previewNet.toFixed(2)}
            </p>

            {isOfficer && expanded.status === "pending" && (
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  onClick={handleComplete}
                  disabled={busy || expanded.participants.length === 0}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  Complete
                </button>
                <button
                  onClick={handleNotCompleted}
                  disabled={busy}
                  className="rounded-full border border-amber-600 bg-transparent px-4 py-2 text-sm font-semibold text-amber-600 transition hover:bg-amber-600 hover:text-white disabled:opacity-40 dark:border-amber-500 dark:text-amber-400"
                >
                  Not completed
                </button>
                <button
                  onClick={handleLost}
                  disabled={busy}
                  className="rounded-full border border-red-600 bg-transparent px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-600 hover:text-white disabled:opacity-40 dark:border-red-500 dark:text-red-400"
                >
                  Lost
                </button>
              </div>
            )}

            <table className="mt-4 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2 pr-4">User</th>
                  <th className="py-2 pr-4">Weight</th>
                  <th className="py-2 pr-4">Weight %</th>
                  <th className="py-2 pr-4">Share</th>
                  {isOfficer && expanded.status === "pending" && <th className="py-2 pr-4" />}
                </tr>
              </thead>
              <tbody>
                {expanded.participants.map((p) => (
                  <tr key={p.user_id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4">{p.username}</td>
                    <td className="py-2 pr-4">{p.weight}</td>
                    <td className="py-2 pr-4">
                      {totalWeight > 0
                        ? `${((p.weight / totalWeight) * 100).toFixed(2)}%`
                        : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {p.share_amount ??
                        (totalWeight > 0
                          ? (
                              (Number(expanded.net_value ?? previewNet) * p.weight) /
                              totalWeight
                            ).toFixed(2)
                          : "0.00")}
                    </td>
                    {isOfficer && expanded.status === "pending" && (
                      <td className="py-2 pr-4">
                        <button
                          onClick={() => handleRemoveParticipant(p.user_id)}
                          disabled={busy}
                          className="text-xs text-red-600 hover:underline dark:text-red-400"
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {isOfficer && expanded.status === "pending" && (
              <form onSubmit={handleAddParticipant} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  Participant
                  <select
                    value={participantUserId}
                    onChange={(e) => setParticipantUserId(e.target.value)}
                    className="rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                    required
                  >
                    <option value="" disabled>
                      Select a user
                    </option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Weight
                  <input
                    type="number"
                    min={1}
                    value={participantWeight}
                    onChange={(e) => setParticipantWeight(e.target.value)}
                    className="w-24 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                >
                  Add/update participant
                </button>
              </form>
            )}
          </div>
        )}

        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="text-lg font-semibold">All splits</h3>
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="py-2 pr-4">Note</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Market value</th>
                <th className="py-2 pr-4">Net value</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Participants</th>
              </tr>
            </thead>
            <tbody>
              {splits.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-zinc-500 dark:text-zinc-400">
                    No splits yet.
                  </td>
                </tr>
              ) : (
                splits.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openSplit(s.id)}
                    className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                  >
                    <td className="py-2 pr-4">{s.note || "—"}</td>
                    <td className="py-2 pr-4 capitalize">{s.status.replace("_", " ")}</td>
                    <td className="py-2 pr-4">{s.estimated_market_value}</td>
                    <td className="py-2 pr-4">{s.net_value ?? "—"}</td>
                    <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">
                      {new Date(s.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4">{s.participant_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
