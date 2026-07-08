type BuildRole = "healer" | "support" | "dps" | "tank" | "battle_mount" | "brawler";
type BuildSlot = "weapon" | "off_hand" | "head" | "armor" | "shoes" | "cape" | "bag" | "potion" | "food" | "mount";
type OpenAlbionItemType = "weapon" | "armor" | "accessory" | "consumable";

interface BuildCategory {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
}

interface CompCategory {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
}

interface BuildItem {
  slot: BuildSlot;
  openalbion_item_type: OpenAlbionItemType;
  openalbion_item_id: number;
  openalbion_item_name: string;
  openalbion_item_icon?: string | null;
  openalbion_item_tier?: string | null;
}

interface Build {
  id: number;
  name: string;
  description: string | null;
  role: BuildRole;
  category_id: number;
  category_name?: string;
  created_by_username: string;
  created_at: string;
  updated_at: string;
  items: BuildItem[];
}

interface BuildSummary {
  id: number;
  name: string;
  role: BuildRole;
  category_id: number;
  category_name?: string;
  created_by_username: string;
  updated_at: string;
  item_count: number;
}

interface CompBuild {
  build_id: number;
  build: BuildSummary;
  quantity: number;
}

interface Comp {
  id: number;
  name: string;
  description: string | null;
  category_id: number;
  category_name?: string;
  created_by_username: string;
  created_at: string;
  updated_at: string;
  builds: CompBuild[];
}

interface CompSummary {
  id: number;
  name: string;
  category_id: number;
  category_name?: string;
  created_by_username: string;
  created_at: string;
  build_count: number;
  total_quantity: number;
}

interface PaginatedResponse<T> {
  items: T[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
  const body = await res.json();
  return body.data as T;
}

// Build Categories
export async function listBuildCategories(): Promise<BuildCategory[]> {
  const res = await fetch("/api/comps/build-categories");
  return unwrap<BuildCategory[]>(res);
}

export async function createBuildCategory(input: {
  name: string;
  description?: string;
}): Promise<BuildCategory> {
  const res = await fetch("/api/comps/build-categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<BuildCategory>(res);
}

export async function updateBuildCategory(
  id: number,
  input: { name?: string; description?: string }
): Promise<BuildCategory> {
  const res = await fetch(`/api/comps/build-categories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<BuildCategory>(res);
}

export async function deleteBuildCategory(id: number): Promise<void> {
  const res = await fetch(`/api/comps/build-categories/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
}

// Comp Categories
export async function listCompCategories(): Promise<CompCategory[]> {
  const res = await fetch("/api/comps/comp-categories");
  return unwrap<CompCategory[]>(res);
}

export async function createCompCategory(input: {
  name: string;
  description?: string;
}): Promise<CompCategory> {
  const res = await fetch("/api/comps/comp-categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<CompCategory>(res);
}

export async function updateCompCategory(
  id: number,
  input: { name?: string; description?: string }
): Promise<CompCategory> {
  const res = await fetch(`/api/comps/comp-categories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<CompCategory>(res);
}

export async function deleteCompCategory(id: number): Promise<void> {
  const res = await fetch(`/api/comps/comp-categories/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
}

// Builds
export async function listBuilds(
  params?: {
    role?: BuildRole;
    category_id?: number;
    q?: string;
    page?: number;
    limit?: number;
  }
): Promise<PaginatedResponse<BuildSummary>> {
  const searchParams = new URLSearchParams();
  if (params?.role) searchParams.set("role", params.role);
  if (params?.category_id) searchParams.set("category_id", String(params.category_id));
  if (params?.q) searchParams.set("q", params.q);
  searchParams.set("page", String(params?.page ?? 1));
  searchParams.set("limit", String(params?.limit ?? 50));

  const res = await fetch(`/api/comps/builds?${searchParams.toString()}`);
  return unwrap<PaginatedResponse<BuildSummary>>(res);
}

export async function createBuild(input: {
  name: string;
  description?: string;
  role: BuildRole;
  category_id: number;
  items?: Array<{
    slot: BuildSlot;
    openalbion_item_type: OpenAlbionItemType;
    openalbion_item_id: number;
    openalbion_item_name: string;
    openalbion_item_icon?: string;
    openalbion_item_tier?: string;
  }>;
}): Promise<Build> {
  const res = await fetch("/api/comps/builds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Build>(res);
}

export async function getBuild(id: number): Promise<Build> {
  const res = await fetch(`/api/comps/builds/${id}`);
  return unwrap<Build>(res);
}

export async function updateBuild(
  id: number,
  input: {
    name?: string;
    description?: string;
    role?: BuildRole;
    category_id?: number;
  }
): Promise<Build> {
  const res = await fetch(`/api/comps/builds/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Build>(res);
}

export async function deleteBuild(id: number): Promise<void> {
  const res = await fetch(`/api/comps/builds/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
}

export async function upsertBuildItem(
  buildId: number,
  slot: BuildSlot,
  input: {
    openalbion_item_type: OpenAlbionItemType;
    openalbion_item_id: number;
    openalbion_item_name: string;
    openalbion_item_icon?: string;
    openalbion_item_tier?: string;
  }
): Promise<Build> {
  const res = await fetch(`/api/comps/builds/${buildId}/items/${slot}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Build>(res);
}

export async function removeBuildItem(buildId: number, slot: BuildSlot): Promise<Build> {
  const res = await fetch(`/api/comps/builds/${buildId}/items/${slot}`, {
    method: "DELETE",
  });
  return unwrap<Build>(res);
}

// Comps
export async function listComps(params?: {
  category_id?: number;
  q?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResponse<CompSummary>> {
  const searchParams = new URLSearchParams();
  if (params?.category_id) searchParams.set("category_id", String(params.category_id));
  if (params?.q) searchParams.set("q", params.q);
  searchParams.set("page", String(params?.page ?? 1));
  searchParams.set("limit", String(params?.limit ?? 50));

  const res = await fetch(`/api/comps?${searchParams.toString()}`);
  return unwrap<PaginatedResponse<CompSummary>>(res);
}

export async function createComp(input: {
  name: string;
  description?: string;
  category_id: number;
  builds: Array<{ build_id: number; quantity: number }>;
}): Promise<Comp> {
  const res = await fetch("/api/comps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Comp>(res);
}

export async function getComp(id: number): Promise<Comp> {
  const res = await fetch(`/api/comps/${id}`);
  return unwrap<Comp>(res);
}

export async function updateComp(
  id: number,
  input: {
    name?: string;
    description?: string;
    category_id?: number;
  }
): Promise<Comp> {
  const res = await fetch(`/api/comps/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Comp>(res);
}

export async function deleteComp(id: number): Promise<void> {
  const res = await fetch(`/api/comps/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Request failed with status ${res.status}`);
  }
}

export async function addCompBuild(
  compId: number,
  input: { build_id: number; quantity: number }
): Promise<Comp> {
  const res = await fetch(`/api/comps/${compId}/builds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Comp>(res);
}

export async function updateCompBuildQuantity(
  compId: number,
  buildId: number,
  input: { quantity: number }
): Promise<Comp> {
  const res = await fetch(`/api/comps/${compId}/builds/${buildId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<Comp>(res);
}

export async function removeCompBuild(compId: number, buildId: number): Promise<Comp> {
  const res = await fetch(`/api/comps/${compId}/builds/${buildId}`, {
    method: "DELETE",
  });
  return unwrap<Comp>(res);
}

export type {
  BuildCategory,
  CompCategory,
  BuildItem,
  Build,
  BuildSummary,
  CompBuild,
  Comp,
  CompSummary,
  BuildRole,
  BuildSlot,
  OpenAlbionItemType,
  PaginatedResponse,
};
