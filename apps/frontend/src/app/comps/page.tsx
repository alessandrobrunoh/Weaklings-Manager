"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import {
  CompSummary,
  listComps,
  listCompCategories,
  CompCategory,
} from "@/services/compService";

export default function Comps() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [comps, setComps] = useState<CompSummary[]>([]);
  const [categories, setCategories] = useState<CompCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [totalItems, setTotalItems] = useState(0);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCompName, setNewCompName] = useState("");
  const [newCompDescription, setNewCompDescription] = useState("");
  const [newCompCategoryId, setNewCompCategoryId] = useState<number | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const [compsRes, categoriesRes] = await Promise.all([
        listComps({
          category_id: selectedCategory ?? undefined,
          q: query || undefined,
          page: 1,
          limit: 100,
        }),
        listCompCategories(),
      ]);
      setComps(compsRes.items);
      setTotalItems(compsRes.total_items);
      setCategories(categoriesRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load comps");
    } finally {
      setBusy(false);
    }
  }, [query, selectedCategory]);

  useEffect(() => {
    if (user) {
      // Fetch-on-mount when auth resolves; refresh's first setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [user, refresh]);

  const handleCreateComp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompName || !newCompCategoryId) return;

    setCreateBusy(true);
    try {
      const { createComp } = await import("@/services/compService");
      await createComp({
        name: newCompName,
        description: newCompDescription || undefined,
        category_id: newCompCategoryId,
        builds: [],
      });
      setShowCreateModal(false);
      setNewCompName("");
      setNewCompDescription("");
      setNewCompCategoryId(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create comp");
    } finally {
      setCreateBusy(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading session...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8 space-y-6">
        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Comps & Configurations</h2>
              <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                Browse and manage team compositions for your guild activities.
              </p>
            </div>
            <div className="flex gap-3">
              <Link
                href="/comps/builder"
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Build Editor
              </Link>
              <Link
                href="/comps/categories"
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Categories
              </Link>
              <button
                onClick={() => setShowCreateModal(true)}
                className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition dark:border-white dark:bg-white dark:text-black"
              >
                New Comp
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search comp name..."
              className="w-full max-w-xs rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
            />
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setSelectedCategory(null)}
                className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                  selectedCategory === null
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-black"
                    : "border-zinc-200 bg-transparent text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                All categories
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                    selectedCategory === cat.id
                      ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-black"
                      : "border-zinc-200 bg-transparent text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Comps</h3>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              {busy ? "Loading..." : `${totalItems} result(s)`}
            </span>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Build Count</th>
                  <th className="py-2 pr-4">Total Quantity</th>
                  <th className="py-2 pr-4">Created By</th>
                  <th className="py-2 pr-4">Created At</th>
                </tr>
              </thead>
              <tbody>
                {comps.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-zinc-500 dark:text-zinc-400">
                      No comps found.
                    </td>
                  </tr>
                ) : (
                  comps.map((comp) => (
                    <tr
                      key={comp.id}
                      className="border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer"
                      onClick={() => router.push(`/comps/${comp.id}`)}
                    >
                      <td className="py-2 pr-4 font-medium">{comp.name}</td>
                      <td className="py-2 pr-4">{comp.category_name || "-"}</td>
                      <td className="py-2 pr-4">{comp.build_count}</td>
                      <td className="py-2 pr-4">{comp.total_quantity}</td>
                      <td className="py-2 pr-4">{comp.created_by_username}</td>
                      <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">
                        {new Date(comp.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 w-full max-w-md">
            <h3 className="text-xl font-bold tracking-tight">Create New Comp</h3>
            <form onSubmit={handleCreateComp} className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={newCompName}
                  onChange={(e) => setNewCompName(e.target.value)}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={newCompDescription}
                  onChange={(e) => setNewCompDescription(e.target.value)}
                  className="w-full rounded-2xl border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Category</label>
                <select
                  value={newCompCategoryId ?? ""}
                  onChange={(e) => setNewCompCategoryId(Number(e.target.value))}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                >
                  <option value="">Select a category</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createBusy || !newCompName || !newCompCategoryId}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  {createBusy ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
