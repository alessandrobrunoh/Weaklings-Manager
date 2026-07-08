"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, use } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import {
  Comp,
  getComp,
  updateComp,
  deleteComp,
  addCompBuild,
  updateCompBuildQuantity,
  removeCompBuild,
  listBuilds,
  BuildSummary,
  listCompCategories,
  CompCategory,
} from "@/services/compService";

export default function CompDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const unwrappedParams = use(params);
  const compId = Number(unwrappedParams.id);

  const [comp, setComp] = useState<Comp | null>(null);
  const [categories, setCategories] = useState<CompCategory[]>([]);
  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategoryId, setEditCategoryId] = useState<number | null>(null);
  const [showAddBuildModal, setShowAddBuildModal] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState<number | null>(null);
  const [buildQuantity, setBuildQuantity] = useState(1);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const [compRes, buildsRes, categoriesRes] = await Promise.all([
        getComp(compId),
        listBuilds({ page: 1, limit: 100 }),
        listCompCategories(),
      ]);
      setComp(compRes);
      setBuilds(buildsRes.items);
      setCategories(categoriesRes);
      setEditName(compRes.name);
      setEditDescription(compRes.description || "");
      setEditCategoryId(compRes.category_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load comp");
    } finally {
      setBusy(false);
    }
  }, [compId]);

  useEffect(() => {
    if (user) {
      // Fetch-on-mount when auth resolves; refresh's first setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [user, refresh]);

  const handleUpdateComp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName || !editCategoryId) return;

    setBusy(true);
    try {
      await updateComp(compId, {
        name: editName,
        description: editDescription || undefined,
        category_id: editCategoryId,
      });
      setShowEditModal(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update comp");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteComp = async () => {
    if (!confirm("Are you sure you want to delete this comp?")) return;

    setBusy(true);
    try {
      await deleteComp(compId);
      router.push("/comps");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete comp");
      setBusy(false);
    }
  };

  const handleAddBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedBuildId === null) return;

    setBusy(true);
    try {
      await addCompBuild(compId, {
        build_id: selectedBuildId,
        quantity: buildQuantity,
      });
      setShowAddBuildModal(false);
      setSelectedBuildId(null);
      setBuildQuantity(1);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add build");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateQuantity = async (buildId: number, quantity: number) => {
    setBusy(true);
    try {
      await updateCompBuildQuantity(compId, buildId, { quantity });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update quantity");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveBuild = async (buildId: number) => {
    if (!confirm("Remove this build from the comp?")) return;

    setBusy(true);
    try {
      await removeCompBuild(compId, buildId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove build");
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

  if (!comp) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading comp...</p>
      </div>
    );
  }

  const groupedBuilds = comp.builds.reduce((acc, compBuild) => {
    const role = compBuild.build.role;
    if (!acc[role]) acc[role] = [];
    acc[role].push(compBuild);
    return acc;
  }, {} as Record<string, typeof comp.builds>);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8 space-y-6">
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/30 dark:bg-red-950/20">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">{comp.name}</h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Category: {comp.category_name || "-"}
              </p>
              {comp.description && (
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">{comp.description}</p>
              )}
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Created by {comp.created_by_username} • {new Date(comp.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowEditModal(true)}
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Edit
              </button>
              <button
                onClick={handleDeleteComp}
                disabled={busy}
                className="rounded-full border border-red-600 bg-transparent px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-600 hover:text-white disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Builds</h3>
            <button
              onClick={() => setShowAddBuildModal(true)}
              className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition dark:border-white dark:bg-white dark:text-black"
            >
              Add Build
            </button>
          </div>

          <div className="mt-6 space-y-6">
            {Object.entries(groupedBuilds).map(([role, compBuilds]) => (
              <div key={role}>
                <h4 className="mb-3 text-sm font-semibold uppercase text-zinc-500 dark:text-zinc-400">
                  {role.replace(/_/g, " ")}
                </h4>
                <div className="space-y-2">
                  {compBuilds.map((compBuild) => (
                    <div
                      key={compBuild.build_id}
                      className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <Link
                            href={`/comps/builder?buildId=${compBuild.build_id}`}
                            className="font-medium hover:underline"
                          >
                            {compBuild.build.name}
                          </Link>
                          <span className="text-sm text-zinc-500 dark:text-zinc-400">
                            Qty: {compBuild.quantity}
                          </span>
                          <div className="flex gap-1">
                            {compBuild.build.item_count > 0 && (
                              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                                {compBuild.build.item_count} items
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              const newQty = prompt("Enter new quantity:", String(compBuild.quantity));
                              if (newQty && !isNaN(Number(newQty))) {
                                handleUpdateQuantity(compBuild.build_id, Number(newQty));
                              }
                            }}
                            className="rounded-full border border-zinc-200 bg-transparent px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                          >
                            Edit Qty
                          </button>
                          <button
                            onClick={() => handleRemoveBuild(compBuild.build_id)}
                            className="rounded-full border border-red-600 bg-transparent px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-600 hover:text-white"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {comp.builds.length === 0 && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No builds in this comp yet.</p>
            )}
          </div>
        </div>
      </main>

      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 w-full max-w-md">
            <h3 className="text-xl font-bold tracking-tight">Edit Comp</h3>
            <form onSubmit={handleUpdateComp} className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full rounded-2xl border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Category</label>
                <select
                  value={editCategoryId ?? ""}
                  onChange={(e) => setEditCategoryId(Number(e.target.value))}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                >
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
                  onClick={() => setShowEditModal(false)}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !editName || !editCategoryId}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  {busy ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddBuildModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 w-full max-w-md">
            <h3 className="text-xl font-bold tracking-tight">Add Build</h3>
            <form onSubmit={handleAddBuild} className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Build</label>
                <select
                  value={selectedBuildId ?? ""}
                  onChange={(e) => setSelectedBuildId(Number(e.target.value))}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                >
                  <option value="">Select a build</option>
                  {builds.map((build) => (
                    <option key={build.id} value={build.id}>
                      {build.name} ({build.role})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Quantity</label>
                <input
                  type="number"
                  min={1}
                  value={buildQuantity}
                  onChange={(e) => setBuildQuantity(Number(e.target.value))}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setShowAddBuildModal(false)}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || selectedBuildId === null}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  {busy ? "Adding..." : "Add"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
