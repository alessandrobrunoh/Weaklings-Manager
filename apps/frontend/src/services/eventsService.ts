import { CompSummary, PaginatedResponse } from "./compService";

export interface EventView {
  id: number;
  title: string;
  description: string | null;
  comp_id: number;
  comp_name: string;
  created_by: number;
  created_by_username: string;
  event_date_utc: string;
  created_at: string;
  updated_at: string;
  status: string;
  started_at: string | null;
  stopped_at: string | null;
  auto_stop_deadline: string | null;
  link_status: string;
  link_attempts: number;
  link_last_error: string | null;
  link_battles_completed_at: string | null;
}

export interface EventParticipantView {
  user_id: number;
  username: string;
  primary_build_id: number;
  primary_build_name: string;
  secondary_build_id: number | null;
  secondary_build_name: string | null;
}

export interface EventBattleView {
  id: number;
  albionbb_battle_id: string;
  battle_started_at: string;
  guild_players_count: number;
  battle_total_players: number | null;
  fetched_at: string;
}

export interface EventDetailView extends EventView {
  active_comp_id: number;
  active_comp_name: string;
  active_comp_capacity: number;
  participants: EventParticipantView[];
  battles: EventBattleView[];
}

export interface CreateEventRequest {
  title: string;
  description?: string;
  comp_id: number;
  event_date_utc: string;
}

export interface UpdateEventRequest {
  title?: string;
  description?: string;
  comp_id?: number;
  event_date_utc?: string;
}

export interface ParticipateEventRequest {
  primary_build_id: number;
  secondary_build_id?: number | null;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
  const body = await res.json();
  return body.data as T;
}

export async function listEvents(page = 1, limit = 10): Promise<PaginatedResponse<EventView>> {
  const searchParams = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  const res = await fetch(`/api/events?${searchParams.toString()}`);
  return unwrap<PaginatedResponse<EventView>>(res);
}

export async function getEvent(id: number): Promise<EventDetailView> {
  const res = await fetch(`/api/events/${id}`);
  return unwrap<EventDetailView>(res);
}

export async function createEvent(req: CreateEventRequest): Promise<EventView> {
  const res = await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  return unwrap<EventView>(res);
}

export async function updateEvent(id: number, req: UpdateEventRequest): Promise<EventView> {
  const res = await fetch(`/api/events/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  return unwrap<EventView>(res);
}

export async function deleteEvent(id: number): Promise<void> {
  const res = await fetch(`/api/events/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
}

export async function participateEvent(id: number, req: ParticipateEventRequest): Promise<EventDetailView> {
  const res = await fetch(`/api/events/${id}/participate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  return unwrap<EventDetailView>(res);
}

export async function leaveEvent(id: number): Promise<EventDetailView> {
  const res = await fetch(`/api/events/${id}/participate`, {
    method: "DELETE",
  });
  return unwrap<EventDetailView>(res);
}

export async function startEvent(id: number): Promise<EventView> {
  const res = await fetch(`/api/events/${id}/start`, {
    method: "POST",
  });
  return unwrap<EventView>(res);
}

export async function stopEvent(id: number): Promise<EventView> {
  const res = await fetch(`/api/events/${id}/stop`, {
    method: "POST",
  });
  return unwrap<EventView>(res);
}
