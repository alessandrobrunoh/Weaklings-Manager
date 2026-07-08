"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import {
  BuildCategory,
  CompCategory,
  listBuildCategories,
  createBuildCategory,
  updateBuildCategory,
  deleteBuildCategory,
  listCompCategories,
  createCompCategory,
  updateCompCategory,
  deleteCompCategory,
} from "@/services/compService";

export default function CategoriesPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [buildCategories, setBuildCategories] = useState<BuildCategory[]>([]);
  const [compCategories, setCompCategories] = useState<CompCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newBuildCatName, setNewBuildCatName] = useState("");
  const [newBuildCatDesc, setNewBuildCatDesc] = useState("");
  const [editingBuildCat, setEditingBuildCat] = useState<BuildCategory | null>(null);

  const [newCompCatName, setNewCompCatName] = useState("");
  const [newCompCatDesc, setNewCompCatDesc] = useState("");
  const [editingCompCat, setEditingCompCat] = useState<CompCategory | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const [buildCats, compCats] = await Promise.all([
        listBuildCategories(),
        listCompCategories(),
      ]);
      setBuildCategories(buildCats);
      setCompCategories(compCats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load categories");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      // Fetch-on-mount when auth resolves; refresh's first setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [user, refresh]);

  const handleCreateBuildCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBuildCatName) return;

    setBusy(true);
    try {
      await createBuildCategory({
        name: newBuildCatName,
        description: newBuildCatDesc || undefined,
      });
      setNewBuildCatName("");
      setNewBuildCatDesc("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create build category");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateBuildCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBuildCat || !editingBuildCat.name) return;

    setBusy(true);
    try {
      await updateBuildCategory(editingBuildCat.id, {
        name: editingBuildCat.name,
        description: editingBuildCat.description || undefined,
      });
      setEditingBuildCat(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update build category");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteBuildCategory = async (id: number) => {
    if (!confirm("Delete this build category?")) return;

    setBusy(true);
    try {
      await deleteBuildCategory(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete build category");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCompCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompCatName) return;

    setBusy(true);
    try {
      await createCompCategory({
        name: newCompCatName,
        description: newCompCatDesc || undefined,
      });
      setNewCompCatName("");
      setNewCompCatDesc("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create comp category");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateCompCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCompCat || !editingCompCat.name) return;

    setBusy(true);
    try {
      await updateCompCategory(editingCompCat.id, {
        name: editingCompCat.name,
        description: editingCompCat.description || undefined,
      });
      setEditingCompCat(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update comp category");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCompCategory = async (id: number) => {
    if (!confirm("Delete this comp category?")) return;

    setBusy(true);
    try {
      await deleteCompCategory(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete comp category");
    } finally {
      setBusy(false);
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
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Categories</h2>
              <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                Manage build and comp categories for organizing your compositions.
              </p>
            </div>
            <Link
              href="/comps"
              className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
            >
              Back to Comps
            </Link>
          </div>

          {error && (
            <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/30 dark:bg-red-950/20">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <div className="space-y-8">
            {/* Build Categories */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Build Categories</h3>
              <form onSubmit={handleCreateBuildCategory} className="mb-4 flex gap-3">
                <input
                  type="text"
                  value={newBuildCatName}
                  onChange={(e) => setNewBuildCatName(e.target.value)}
                  placeholder="New category name..."
                  required
                  className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
                <input
                  type="text"
                  value={newBuildCatDesc}
                  onChange={(e) => setNewBuildCatDesc(e.target.value)}
                  placeholder="Description (optional)..."
                  className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
                <button
                  type="submit"
                  disabled={busy || !newBuildCatName}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  Add
                </button>
              </form>

              <div className="space-y-2">
                {buildCategories.map((cat) => (
                  <div
                    key={cat.id}
                    className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
                  >
                    {editingBuildCat?.id === cat.id ? (
                      <form onSubmit={handleUpdateBuildCategory} className="flex gap-3">
                        <input
                          type="text"
                          value={editingBuildCat.name}
                          onChange={(e) =>
                            setEditingBuildCat({ ...editingBuildCat, name: e.target.value })
                          }
                          required
                          className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                        />
                        <input
                          type="text"
                          value={editingBuildCat.description || ""}
                          onChange={(e) =>
                            setEditingBuildCat({
                              ...editingBuildCat,
                              description: e.target.value,
                            })
                          }
                          className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                        />
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingBuildCat(null)}
                          className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{cat.name}</p>
                          {cat.description && (
                            <p className="text-sm text-zinc-500 dark:text-zinc-400">
                              {cat.description}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setEditingBuildCat(cat)}
                            className="rounded-full border border-zinc-200 bg-transparent px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteBuildCategory(cat.id)}
                            className="rounded-full border border-red-600 bg-transparent px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-600 hover:text-white"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Comp Categories */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Comp Categories</h3>
              <form onSubmit={handleCreateCompCategory} className="mb-4 flex gap-3">
                <input
                  type="text"
                  value={newCompCatName}
                  onChange={(e) => setNewCompCatName(e.target.value)}
                  placeholder="New category name..."
                  required
                  className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
                <input
                  type="text"
                  value={newCompCatDesc}
                  onChange={(e) => setNewCompCatDesc(e.target.value)}
                  placeholder="Description (optional)..."
                  className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
                <button
                  type="submit"
                  disabled={busy || !newCompCatName}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  Add
                </button>
              </form>

              <div className="space-y-2">
                {compCategories.map((cat) => (
                  <div
                    key={cat.id}
                    className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
                  >
                    {editingCompCat?.id === cat.id ? (
                      <form onSubmit={handleUpdateCompCategory} className="flex gap-3">
                        <input
                          type="text"
                          value={editingCompCat.name}
                          onChange={(e) =>
                            setEditingCompCat({ ...editingCompCat, name: e.target.value })
                          }
                          required
                          className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                        />
                        <input
                          type="text"
                          value={editingCompCat.description || ""}
                          onChange={(e) =>
                            setEditingCompCat({
                              ...editingCompCat,
                              description: e.target.value,
                            })
                          }
                          className="flex-1 rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                        />
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingCompCat(null)}
                          className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{cat.name}</p>
                          {cat.description && (
                            <p className="text-sm text-zinc-500 dark:text-zinc-400">
                              {cat.description}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setEditingCompCat(cat)}
                            className="rounded-full border border-zinc-200 bg-transparent px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteCompCategory(cat.id)}
                            className="rounded-full border border-red-600 bg-transparent px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-600 hover:text-white"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
