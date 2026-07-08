"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, Suspense } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import {
  Build,
  BuildSummary,
  BuildItem,
  BuildSlot,
  BuildRole,
  listBuilds,
  createBuild,
  getBuild,
  updateBuild,
  listBuildCategories,
  BuildCategory,
  OpenAlbionItemType,
} from "@/services/compService";
import { listItems, OpenAlbionItem } from "@/services/openAlbionService";

const SLOT_LABELS: Record<BuildSlot, string> = {
  weapon: "Weapon",
  off_hand: "Off Hand",
  head: "Head",
  armor: "Armor",
  shoes: "Shoes",
  cape: "Cape",
  bag: "Bag",
  potion: "Potion",
  food: "Food",
  mount: "Mount",
};

const SLOT_TO_ITEM_TYPE: Record<BuildSlot, OpenAlbionItemType> = {
  weapon: "weapon",
  off_hand: "weapon",
  head: "armor",
  armor: "armor",
  shoes: "armor",
  cape: "accessory",
  bag: "accessory",
  potion: "consumable",
  food: "consumable",
  mount: "accessory",
};

const ROLES: BuildRole[] = ["healer", "support", "dps", "tank", "battle_mount", "brawler"];

interface SlotPickerState {
  slot: BuildSlot | null;
  open: boolean;
  query: string;
  results: OpenAlbionItem[];
}

function BuildEditor() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editBuildId = searchParams.get("buildId");

  const [build, setBuild] = useState<Build | null>(null);
  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [categories, setCategories] = useState<BuildCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<BuildRole>("dps");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [items, setItems] = useState<Record<BuildSlot, BuildItem | null>>({
    weapon: null,
    off_hand: null,
    head: null,
    armor: null,
    shoes: null,
    cape: null,
    bag: null,
    potion: null,
    food: null,
    mount: null,
  });
  const [slotPicker, setSlotPicker] = useState<SlotPickerState>({
    slot: null,
    open: false,
    query: "",
    results: [],
  });

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const [buildsRes, categoriesRes] = await Promise.all([
        listBuilds({ page: 1, limit: 100 }),
        listBuildCategories(),
      ]);
      setBuilds(buildsRes.items);
      setCategories(categoriesRes);

      if (editBuildId) {
        const buildRes = await getBuild(Number(editBuildId));
        setBuild(buildRes);
        setName(buildRes.name);
        setDescription(buildRes.description || "");
        setRole(buildRes.role);
        setCategoryId(buildRes.category_id);

        const itemsMap: Record<BuildSlot, BuildItem | null> = {
          weapon: null,
          off_hand: null,
          head: null,
          armor: null,
          shoes: null,
          cape: null,
          bag: null,
          potion: null,
          food: null,
          mount: null,
        };
        buildRes.items.forEach((item) => {
          itemsMap[item.slot] = item;
        });
        setItems(itemsMap);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setBusy(false);
    }
  }, [editBuildId]);

  useEffect(() => {
    if (user) {
      // Fetch-on-mount when auth resolves; refresh's first setState is intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [user, refresh]);

  useEffect(() => {
    const searchItems = async () => {
      if (!slotPicker.slot || !slotPicker.open) return;

      try {
        const itemType = SLOT_TO_ITEM_TYPE[slotPicker.slot];
        const res = await listItems(
          itemType,
          slotPicker.query || undefined,
          undefined,
          undefined,
          undefined,
          1,
          50
        );
        setSlotPicker((prev) => ({ ...prev, results: res.items }));
      } catch (e) {
        console.error("Failed to search items:", e);
      }
    };

    const timeoutId = setTimeout(searchItems, 300);
    return () => clearTimeout(timeoutId);
  }, [slotPicker.query, slotPicker.slot, slotPicker.open]);

  const openSlotPicker = (slot: BuildSlot) => {
    setSlotPicker({
      slot,
      open: true,
      query: "",
      results: [],
    });
  };

  const selectItem = (item: OpenAlbionItem) => {
    if (!slotPicker.slot) return;

    const buildItem: BuildItem = {
      slot: slotPicker.slot,
      openalbion_item_type: SLOT_TO_ITEM_TYPE[slotPicker.slot],
      openalbion_item_id: item.id,
      openalbion_item_name: item.name,
      openalbion_item_icon: item.icon || null,
      openalbion_item_tier: item.tier || null,
    };

    setItems((prev) => ({ ...prev, [slotPicker.slot!]: buildItem }));
    setSlotPicker({ slot: null, open: false, query: "", results: [] });
  };

  const clearSlot = (slot: BuildSlot) => {
    setItems((prev) => ({ ...prev, [slot]: null }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !categoryId) return;

    setBusy(true);
    try {
      const itemsArray = Object.values(items).filter((i): i is BuildItem => i !== null);

      if (editBuildId) {
        await updateBuild(Number(editBuildId), {
          name,
          description: description || undefined,
          role,
          category_id: categoryId,
        });

        const buildId = Number(editBuildId);
        for (const slot of Object.keys(items) as BuildSlot[]) {
          const item = items[slot];
          if (item) {
            await (
              await import("@/services/compService")
            ).upsertBuildItem(buildId, slot, {
              openalbion_item_type: item.openalbion_item_type,
              openalbion_item_id: item.openalbion_item_id,
              openalbion_item_name: item.openalbion_item_name,
              openalbion_item_icon: item.openalbion_item_icon || undefined,
              openalbion_item_tier: item.openalbion_item_tier || undefined,
            });
          } else {
            await (
              await import("@/services/compService")
            ).removeBuildItem(buildId, slot);
          }
        }
      } else {
        await createBuild({
          name,
          description: description || undefined,
          role,
          category_id: categoryId,
          items: itemsArray.map((item) => ({
            slot: item.slot,
            openalbion_item_type: item.openalbion_item_type,
            openalbion_item_id: item.openalbion_item_id,
            openalbion_item_name: item.openalbion_item_name,
            openalbion_item_icon: item.openalbion_item_icon || undefined,
            openalbion_item_tier: item.openalbion_item_tier || undefined,
          })),
        });
      }

      router.push("/comps");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save build");
      setBusy(false);
    }
  };

  const loadBuildForEdit = async (buildId: number) => {
    setBusy(true);
    try {
      const buildRes = await getBuild(buildId);
      router.push(`/comps/builder?buildId=${buildId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load build");
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
      <main className="mx-auto max-w-6xl px-6 py-8 lg:px-8">
        <div className="flex gap-6">
          <div className="flex-1 space-y-6">
            <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold tracking-tight">
                  {editBuildId ? "Edit Build" : "New Build"}
                </h2>
                <Link
                  href="/comps"
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                >
                  Back to Comps
                </Link>
              </div>

              {error && (
                <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/30 dark:bg-red-950/20">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <form onSubmit={handleSave} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full rounded-2xl border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                    rows={3}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Role</label>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as BuildRole)}
                      required
                      className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Category</label>
                    <select
                      value={categoryId ?? ""}
                      onChange={(e) => setCategoryId(Number(e.target.value))}
                      required
                      className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                    >
                      <option value="">Select category</option>
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-3">Equipment Slots</label>
                  <div className="grid grid-cols-2 gap-4">
                    {(Object.keys(SLOT_LABELS) as BuildSlot[]).map((slot) => (
                      <div
                        key={slot}
                        className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium">{SLOT_LABELS[slot]}</span>
                          {items[slot] && (
                            <button
                              type="button"
                              onClick={() => clearSlot(slot)}
                              className="text-xs text-red-600 hover:text-red-700 dark:text-red-400"
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {items[slot] ? (
                          <div className="flex items-center gap-3">
                            {items[slot]!.openalbion_item_icon && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={items[slot]!.openalbion_item_icon!}
                                alt={items[slot]!.openalbion_item_name}
                                className="h-10 w-10 rounded-lg"
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">
                                {items[slot]!.openalbion_item_name}
                              </p>
                              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                {items[slot]!.openalbion_item_tier || "-"}
                              </p>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openSlotPicker(slot)}
                            className="w-full rounded-xl border border-dashed border-zinc-300 bg-transparent px-4 py-3 text-sm text-zinc-500 transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                          >
                            + Add item
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex gap-3 justify-end">
                  <Link
                    href="/comps"
                    className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                  >
                    Cancel
                  </Link>
                  <button
                    type="submit"
                    disabled={busy || !name || !categoryId}
                    className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                  >
                    {busy ? "Saving..." : editBuildId ? "Update Build" : "Create Build"}
                  </button>
                </div>
              </form>
            </div>
          </div>

          <div className="w-64 space-y-4">
            <h3 className="text-sm font-semibold uppercase text-zinc-500 dark:text-zinc-400">
              Existing Builds
            </h3>
            <div className="space-y-2">
              {builds.length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">No builds yet.</p>
              ) : (
                builds.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => loadBuildForEdit(b.id)}
                    className={`w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-sm transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 ${
                      editBuildId === String(b.id)
                        ? "border-zinc-950 bg-zinc-100 dark:border-white dark:bg-zinc-800"
                        : ""
                    }`}
                  >
                    <p className="font-medium truncate">{b.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {b.role.replace(/_/g, " ")}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {slotPicker.open && slotPicker.slot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 w-full max-w-lg max-h-[80vh] flex flex-col">
            <h3 className="text-xl font-bold tracking-tight mb-4">
              Select {SLOT_LABELS[slotPicker.slot]}
            </h3>

            <input
              type="text"
              value={slotPicker.query}
              onChange={(e) =>
                setSlotPicker((prev) => ({ ...prev, query: e.target.value }))
              }
              placeholder="Search items..."
              className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white mb-4"
              autoFocus
            />

            <div className="flex-1 overflow-y-auto space-y-2">
              {slotPicker.results.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-4">
                  {slotPicker.query ? "No items found" : "Type to search..."}
                </p>
              ) : (
                slotPicker.results.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectItem(item)}
                    className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    <div className="flex items-center gap-3">
                      {item.icon && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.icon}
                          alt={item.name}
                          className="h-10 w-10 rounded-lg"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.name}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {item.tier || "-"} {item.item_power ? `• ${item.item_power} power` : ""}
                        </p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="flex gap-3 justify-end mt-4">
              <button
                type="button"
                onClick={() =>
                  setSlotPicker({ slot: null, open: false, query: "", results: [] })
                }
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BuildEditorPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
          <p className="text-sm font-medium text-zinc-500">Loading builder...</p>
        </div>
      }
    >
      <BuildEditor />
    </Suspense>
  );
}
