"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import { listComps, CompSummary } from "@/services/compService";
import { listEvents, createEvent, EventView } from "@/services/eventsService";

export default function EventsPage() {
  const { user, loading, can } = useAuth();
  const router = useRouter();

  const [events, setEvents] = useState<EventView[]>([]);
  const [comps, setComps] = useState<CompSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Form fields
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newCompId, setNewCompId] = useState<number | null>(null);
  const [newDate, setNewDate] = useState("");
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
      const [eventsRes, compsRes] = await Promise.all([
        listEvents(1, 100),
        listComps({ page: 1, limit: 100 }),
      ]);
      setEvents(eventsRes.items);
      setTotalItems(eventsRes.total_items);
      setComps(compsRes.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load events");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      refresh();
    }
  }, [user, refresh]);

  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle || !newCompId || !newDate) return;

    setCreateBusy(true);
    try {
      // Convert datetime-local to ISO string
      const isoDate = new Date(newDate).toISOString();

      await createEvent({
        title: newTitle,
        description: newDescription || undefined,
        comp_id: newCompId,
        event_date_utc: isoDate,
      });

      setShowCreateModal(false);
      setNewTitle("");
      setNewDescription("");
      setNewCompId(null);
      setNewDate("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create event");
    } finally {
      setCreateBusy(false);
    }
  };

  const isOrganizer = true; // Backend enforces events.manage permission

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
            <h2 className="text-3xl font-extrabold tracking-tight">Guild Events</h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Schedule, manage, and sign up for ZvZ events and dungeons.
            </p>
          </div>
          {isOrganizer && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="rounded-full border border-zinc-950 bg-zinc-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 dark:border-white dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              Create Event
            </button>
          )}
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
            <p className="text-sm font-medium text-red-800 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="mt-8">
          {busy && events.length === 0 ? (
            <div className="flex justify-center py-12">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading events...</p>
            </div>
          ) : events.length === 0 ? (
            <div className="rounded-3xl border border-zinc-200 border-dashed bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="text-lg font-bold">No events scheduled</h3>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Check back later or schedule one if you have permission.
              </p>
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {events.map((event) => {
                const date = new Date(event.event_date_utc);
                const statusBadgeClass =
                  event.status === "live"
                    ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
                    : event.status === "stopped" || event.status === "auto_stopped"
                      ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
                      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
                return (
                  <div
                    key={event.id}
                    className="flex flex-col justify-between rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-xl font-bold tracking-tight">{event.title}</h3>
                        <div className="flex flex-col items-end gap-2">
                          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold dark:bg-zinc-900">
                            {event.comp_name}
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${statusBadgeClass}`}>
                            {event.status.replaceAll("_", " ")}
                          </span>
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300 line-clamp-2">
                        {event.description || "No description provided."}
                      </p>
                      <div className="mt-4 space-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                        <p>
                          📅 <span className="font-semibold">{date.toLocaleDateString()}</span> at{" "}
                          <span className="font-semibold">
                            {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </p>
                        <p>👤 Created by {event.created_by_username}</p>
                      </div>
                    </div>
                    <div className="mt-6">
                      <Link
                        href={`/events/${event.id}`}
                        className="inline-flex w-full justify-center rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                      >
                        Details & Join
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 w-full max-w-md mx-4">
            <h3 className="text-xl font-bold tracking-tight">Create New Event</h3>
            <form onSubmit={handleCreateEvent} className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                  placeholder="e.g. ZvZ Castle Fight"
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Explain event rules, gear requirements, etc."
                  className="w-full rounded-2xl border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Base Composition</label>
                <select
                  value={newCompId ?? ""}
                  onChange={(e) => setNewCompId(Number(e.target.value))}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white dark:bg-zinc-950"
                >
                  <option value="" className="dark:bg-zinc-950">Select a composition</option>
                  {comps.map((comp) => (
                    <option key={comp.id} value={comp.id} className="dark:bg-zinc-950">
                      {comp.name} ({comp.total_quantity} slots)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Event Date & Time (Local)</label>
                <input
                  type="datetime-local"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div className="flex gap-3 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createBusy || !newTitle || !newCompId || !newDate}
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
