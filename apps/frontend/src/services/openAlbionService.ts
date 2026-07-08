/**
 * A single weapon in the Albion Online item catalog, sourced from OpenAlbion.
 */
export interface OpenAlbionWeapon {
  id: number;
  name: string;
  tier?: string;
  item_power?: number;
  icon?: string;
}

/**
 * A single item in the Albion Online item catalog, sourced from OpenAlbion.
 */
export interface OpenAlbionItem {
  id: number;
  name: string;
  tier?: string;
  item_power?: number;
  identifier?: string;
  icon?: string;
  info?: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

/**
 * Lists the Albion Online weapon catalog, optionally filtered by a name substring and/or tier.
 */
export async function listWeapons(
  q?: string,
  tier?: number,
  page = 1,
  limit = 50
): Promise<PaginatedResponse<OpenAlbionWeapon>> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (q) params.set("q", q);
  if (tier) params.set("tier", String(tier));

  const res = await fetch(`/api/openalbion/weapons?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch weapon catalog");
  const data = await res.json();
  return data.data as PaginatedResponse<OpenAlbionWeapon>;
}

/**
 * Lists the Albion Online item catalog, optionally filtered by type, name, tier, and category.
 */
export async function listItems(
  type: "weapon" | "armor" | "accessory" | "consumable",
  q?: string,
  tier?: string,
  categoryId?: number,
  subcategoryId?: number,
  page = 1,
  limit = 50
): Promise<PaginatedResponse<OpenAlbionItem>> {
  const params = new URLSearchParams({
    type,
    page: String(page),
    limit: String(limit),
  });
  if (q) params.set("q", q);
  if (tier) params.set("tier", tier);
  if (categoryId) params.set("category_id", String(categoryId));
  if (subcategoryId) params.set("subcategory_id", String(subcategoryId));

  const res = await fetch(`/api/openalbion/items?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch item catalog");
  const data = await res.json();
  return data.data as PaginatedResponse<OpenAlbionItem>;
}
