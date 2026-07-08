"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, use } from "react";
import { useAuth } from "@/context/AuthContext";
import Header from "@/components/Header";
import { getComp, listComps, Comp, CompSummary } from "@/services/compService";
import {
  getEvent,
  updateEvent,
  deleteEvent,
  participateEvent,
  leaveEvent,
  startEvent,
  stopEvent,
  EventDetailView,
} from "@/services/eventsService";

export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, loading, can } = useAuth();
  const router = useRouter();
  const unwrappedParams = use(params);
  const eventId = Number(unwrappedParams.id);

  const [event, setEvent] = useState<EventDetailView | null>(null);
  const [comp, setComp] = useState<Comp | null>(null);
  const [comps, setComps] = useState<CompSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Edit form state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCompId, setEditCompId] = useState<number | null>(null);
  const [editDate, setEditDate] = useState("");

  // Signup form state
  const [primaryBuildId, setPrimaryBuildId] = useState<number | null>(null);
  const [secondaryBuildId, setSecondaryBuildId] = useState<number | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const eventRes = await getEvent(eventId);
      setEvent(eventRes);

      // Populate edit states
      setEditTitle(eventRes.title);
      setEditDescription(eventRes.description || "");
      setEditCompId(eventRes.comp_id);
      
      // Convert UTC date to local datetime-local format (YYYY-MM-DDThh:mm)
      const dateObj = new Date(eventRes.event_date_utc);
      const localString = new Date(dateObj.getTime() - dateObj.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      setEditDate(localString);

      // Get current active composition details
      const compRes = await getComp(eventRes.active_comp_id);
      setComp(compRes);

      // If user is organizer, also load all compositions for edit dropdown
      if (can("Admin", "Officer")) {
        const compsRes = await listComps({ page: 1, limit: 100 });
        setComps(compsRes.items);
      }

      // Check if user is already participating
      const myParticipation = eventRes.participants.find((p) => p.user_id === user?.user_id);
      if (myParticipation) {
        setPrimaryBuildId(myParticipation.primary_build_id);
        setSecondaryBuildId(myParticipation.secondary_build_id);
      } else {
        setPrimaryBuildId(null);
        setSecondaryBuildId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load event details");
    } finally {
      setBusy(false);
    }
  }, [eventId, user?.user_id]);

  useEffect(() => {
    if (user) {
      refresh();
    }
  }, [user, refresh]);

  const handleUpdateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTitle || !editCompId || !editDate) return;

    setActionBusy(true);
    try {
      const isoDate = new Date(editDate).toISOString();
      await updateEvent(eventId, {
        title: editTitle,
        description: editDescription || undefined,
        comp_id: editCompId,
        event_date_utc: isoDate,
      });
      setShowEditModal(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update event");
    } finally {
      setActionBusy(false);
    }
  };

  const handleDeleteEvent = async () => {
    if (!confirm("Are you sure you want to delete this event? This will also remove all signups.")) return;

    setActionBusy(true);
    try {
      await deleteEvent(eventId);
      router.push("/events");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete event");
      setActionBusy(false);
    }
  };

  const handleStartEvent = async () => {
    setActionBusy(true);
    try {
      await startEvent(eventId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start event");
    } finally {
      setActionBusy(false);
    }
  };

  const handleStopEvent = async () => {
    if (!confirm("Stop this live event session now?")) return;

    setActionBusy(true);
    try {
      await stopEvent(eventId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop event");
    } finally {
      setActionBusy(false);
    }
  };

  const handleJoinEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!primaryBuildId) return;

    setActionBusy(true);
    try {
      await participateEvent(eventId, {
        primary_build_id: primaryBuildId,
        secondary_build_id: secondaryBuildId || null,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sign up for event");
    } finally {
      setActionBusy(false);
    }
  };

  const handleLeaveEvent = async () => {
    if (!confirm("Are you sure you want to leave this event?")) return;

    setActionBusy(true);
    try {
      await leaveEvent(eventId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to leave event");
    } finally {
      setActionBusy(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading session...</p>
      </div>
    );
  }

  if (busy && !event) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex items-center justify-center">
        <p className="text-sm font-medium text-zinc-500">Loading event details...</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black flex flex-col items-center justify-center">
        <p className="text-sm font-medium text-zinc-500 mb-4">Event not found.</p>
        <Link href="/events" className="text-sm font-semibold underline">Back to Events</Link>
      </div>
    );
  }

  const isOrganizer = true; // Backend enforces events.manage permission
  const myParticipation = event.participants.find((p) => p.user_id === user.user_id);
  const eventDate = new Date(event.event_date_utc);
  const isLive = event.status === "live";
  const sessionBadgeClass =
    event.status === "live"
      ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
      : event.status === "stopped" || event.status === "auto_stopped"
        ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
        : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

  // Group current participants by their primary build role/id
  const participantsByBuild: Record<number, typeof event.participants> = {};
  event.participants.forEach((p) => {
    if (!participantsByBuild[p.primary_build_id]) {
      participantsByBuild[p.primary_build_id] = [];
    }
    participantsByBuild[p.primary_build_id].push(p);
  });

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-50">
      <Header />

      <main className="mx-auto max-w-5xl px-6 py-8 lg:px-8">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between border-b border-zinc-200 pb-6 dark:border-zinc-800">
          <div>
            <Link href="/events" className="text-xs font-semibold text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              &larr; Back to Events
            </Link>
            <h2 className="text-3xl font-extrabold tracking-tight mt-1">{event.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-500 dark:text-zinc-400">
              <p>📅 {eventDate.toLocaleString()}</p>
              <p>👤 Organized by {event.created_by_username}</p>
              <p>👥 Active composition: <span className="font-semibold text-zinc-900 dark:text-white">{event.active_comp_name}</span> ({event.participants.length}/{event.active_comp_capacity} players)</p>
              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${sessionBadgeClass}`}>
                {event.status.replaceAll("_", " ")}
              </span>
            </div>
            <div className="mt-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              {event.started_at && <p>Started: {new Date(event.started_at).toLocaleString()}</p>}
              {event.auto_stop_deadline && <p>Auto-stop: {new Date(event.auto_stop_deadline).toLocaleString()}</p>}
              {event.stopped_at && <p>Stopped: {new Date(event.stopped_at).toLocaleString()}</p>}
              <p>Battle linker: <span className="font-semibold text-zinc-700 dark:text-zinc-200">{event.link_status.replaceAll("_", " ")}</span> · attempts {event.link_attempts}</p>
              {event.link_last_error && <p className="text-red-600 dark:text-red-400">Last linker error: {event.link_last_error}</p>}
            </div>
          </div>

          {isOrganizer && (
            <div className="flex flex-wrap gap-3 mt-4 md:mt-0">
              <button
                onClick={() => setShowEditModal(true)}
                className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
              >
                Edit Event
              </button>
              {!isLive ? (
                <button
                  onClick={handleStartEvent}
                  disabled={actionBusy}
                  className="rounded-full border border-green-200 bg-transparent px-4 py-2 text-sm font-semibold text-green-700 transition disabled:opacity-40 hover:bg-green-950 hover:text-white dark:border-green-900/50 dark:text-green-400 dark:hover:bg-green-950/20"
                >
                  {actionBusy ? "Working..." : "Start Event"}
                </button>
              ) : (
                <button
                  onClick={handleStopEvent}
                  disabled={actionBusy}
                  className="rounded-full border border-orange-200 bg-transparent px-4 py-2 text-sm font-semibold text-orange-700 transition disabled:opacity-40 hover:bg-orange-950 hover:text-white dark:border-orange-900/50 dark:text-orange-400 dark:hover:bg-orange-950/20"
                >
                  {actionBusy ? "Working..." : "Stop Event"}
                </button>
              )}
              <button
                onClick={handleDeleteEvent}
                className="rounded-full border border-red-200 bg-transparent px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-950 hover:text-white dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/20"
              >
                Delete Event
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
            <p className="text-sm font-medium text-red-800 dark:text-red-400">{error}</p>
          </div>
        )}

        {event.description && (
          <div className="mt-6 rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Description</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-line">
              {event.description}
            </p>
          </div>
        )}

        <div className="mt-6 rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold tracking-tight">Linked Battles</h3>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Battles found by the background linker within the live session window.
              </p>
            </div>
            <span className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              {event.battles.length} linked
            </span>
          </div>
          {event.battles.length === 0 ? (
            <p className="mt-4 text-sm italic text-zinc-500 dark:text-zinc-400">
              No battles linked yet. If the event is live or was recently stopped, AlbionBB may still be ingesting them.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {event.battles.map((battle) => (
                <Link
                  key={battle.id}
                  href={`/battles/${battle.albionbb_battle_id}`}
                  className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold">Battle #{battle.albionbb_battle_id}</p>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Started {new Date(battle.battle_started_at).toLocaleString()}</p>
                    </div>
                    <span className="rounded-full bg-zinc-200 px-2.5 py-1 text-xs font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {battle.guild_players_count} guild players
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                    Total players: {battle.battle_total_players ?? "unknown"} · refreshed {new Date(battle.fetched_at).toLocaleString()}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 grid gap-8 md:grid-cols-3">
          {/* Left / Middle: Active Comp Layout & Grid */}
          <div className="md:col-span-2 space-y-6">
            <div className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="text-lg font-bold tracking-tight mb-4">Active Comp Roster Details</h3>
              {comp?.builds && comp.builds.length > 0 ? (
                <div className="space-y-6">
                  {comp.builds.map((cb) => {
                    const enrolled = participantsByBuild[cb.build_id] || [];
                    const isFull = enrolled.length >= cb.quantity;
                    return (
                      <div
                        key={cb.build_id}
                        className="rounded-2xl border border-zinc-150 p-4 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col justify-between gap-4"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="font-bold text-base flex items-center gap-2">
                              {cb.build.name}
                              <span className="text-xs font-semibold uppercase px-2 py-0.5 rounded-md bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                                {cb.build.role}
                              </span>
                            </h4>
                            <p className="text-xs text-zinc-500 mt-0.5">Updated: {new Date(cb.build.updated_at).toLocaleDateString()}</p>
                          </div>
                          <span
                            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                              isFull
                                ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
                                : "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
                            }`}
                          >
                            {enrolled.length} / {cb.quantity} filled
                          </span>
                        </div>

                        {enrolled.length > 0 ? (
                          <div className="space-y-1">
                            <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Players:</p>
                            <ul className="grid grid-cols-2 gap-2">
                              {enrolled.map((p) => (
                                <li
                                  key={p.user_id}
                                  className="text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 rounded-full flex items-center justify-between"
                                >
                                  <span className="font-medium truncate max-w-[120px]">{p.username}</span>
                                  {p.secondary_build_name && (
                                    <span className="text-[10px] text-zinc-400 italic font-medium truncate max-w-[70px]" title={`Backup: ${p.secondary_build_name}`}>
                                      ({p.secondary_build_name})
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p className="text-xs text-zinc-400 italic">No players signed up for this role yet.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-zinc-500 italic">This composition has no builds defined.</p>
              )}
            </div>
          </div>

          {/* Right: Join / Leave Event Controls */}
          <div>
            <div className="sticky top-24 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 space-y-6">
              <div>
                <h3 className="text-lg font-bold tracking-tight">Your Event Status</h3>
                <p className="text-sm text-zinc-500 mt-1">
                  {myParticipation
                    ? "You are signed up for this event."
                    : "You are not participating in this event."}
                </p>
              </div>

              {myParticipation && (
                <div className="rounded-2xl border border-zinc-150 p-4 bg-zinc-50 dark:bg-zinc-900/50 space-y-2">
                  <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Your choices</p>
                  <div>
                    <p className="text-sm font-semibold">Primary Build:</p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-300">{myParticipation.primary_build_name}</p>
                  </div>
                  {myParticipation.secondary_build_name && (
                    <div className="pt-1.5 border-t border-zinc-200 dark:border-zinc-800 mt-1">
                      <p className="text-sm font-semibold">Secondary Backup Build:</p>
                      <p className="text-sm text-zinc-600 dark:text-zinc-300">{myParticipation.secondary_build_name}</p>
                    </div>
                  )}
                </div>
              )}

              <form onSubmit={handleJoinEvent} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Primary Build (Required)</label>
                  <select
                    value={primaryBuildId ?? ""}
                    onChange={(e) => setPrimaryBuildId(e.target.value ? Number(e.target.value) : null)}
                    required
                    className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white dark:bg-zinc-950"
                  >
                    <option value="" className="dark:bg-zinc-950">Choose primary build</option>
                    {comp?.builds.map((cb) => {
                      const enrolled = participantsByBuild[cb.build_id] || [];
                      const isFull = enrolled.length >= cb.quantity;
                      // Allow selecting current choice even if slot is full (since they already occupy it!)
                      const isMyCurrentChoice = myParticipation?.primary_build_id === cb.build_id;
                      const disabled = isFull && !isMyCurrentChoice;
                      
                      return (
                        <option
                          key={cb.build_id}
                          value={cb.build_id}
                          disabled={disabled}
                          className="dark:bg-zinc-950"
                        >
                          {cb.build.name} ({cb.build.role}) {disabled ? "[FULL]" : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Secondary Build (Optional)</label>
                  <select
                    value={secondaryBuildId ?? ""}
                    onChange={(e) => setSecondaryBuildId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white dark:bg-zinc-950"
                  >
                    <option value="" className="dark:bg-zinc-950">None (No backup build)</option>
                    {comp?.builds.map((cb) => (
                      <option
                        key={cb.build_id}
                        value={cb.build_id}
                        className="dark:bg-zinc-950"
                      >
                        {cb.build.name} ({cb.build.role})
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-zinc-400 mt-1">Backup builds are not slot-limited.</p>
                </div>

                <div className="flex flex-col gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={actionBusy || !primaryBuildId}
                    className="w-full rounded-full border border-zinc-950 bg-zinc-950 py-2.5 text-sm font-semibold text-white transition disabled:opacity-40 hover:bg-zinc-800 dark:border-white dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                  >
                    {actionBusy ? "Saving..." : myParticipation ? "Update Registration" : "Join Event"}
                  </button>
                  {myParticipation && (
                    <button
                      type="button"
                      onClick={handleLeaveEvent}
                      disabled={actionBusy}
                      className="w-full rounded-full border border-red-200 bg-transparent py-2.5 text-sm font-semibold text-red-700 transition disabled:opacity-40 hover:bg-red-950 hover:text-white dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/20"
                    >
                      Leave Event
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>
      </main>

      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 w-full max-w-md mx-4">
            <h3 className="text-xl font-bold tracking-tight">Edit Event Setup</h3>
            <form onSubmit={handleUpdateEvent} className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  required
                  placeholder="e.g. ZvZ Castle Fight"
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Explain event rules, gear requirements, etc."
                  className="w-full rounded-2xl border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Base Composition</label>
                <select
                  value={editCompId ?? ""}
                  onChange={(e) => setEditCompId(Number(e.target.value))}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white dark:bg-zinc-950"
                >
                  <option value="" className="dark:bg-zinc-950">Select a composition</option>
                  {comps.map((compItem) => (
                    <option key={compItem.id} value={compItem.id} className="dark:bg-zinc-950">
                      {compItem.name} ({compItem.total_quantity} slots)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Event Date & Time (Local)</label>
                <input
                  type="datetime-local"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  required
                  className="w-full rounded-full border border-zinc-200 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-zinc-950 dark:border-zinc-700 dark:focus:border-white"
                />
              </div>
              <div className="flex gap-3 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="rounded-full border border-zinc-200 bg-transparent px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-950 hover:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-white dark:hover:text-black"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionBusy || !editTitle || !editCompId || !editDate}
                  className="rounded-full border border-zinc-950 bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40 dark:border-white dark:bg-white dark:text-black"
                >
                  {actionBusy ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
