/**
 * A user profile, as returned by the user listing endpoint (open to any authenticated user).
 */
export interface UserProfile {
  id: number;
  username: string;
  email: string;
  role: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

/**
 * Lists all users. Used to populate participant pickers.
 */
export async function listUsers(page = 1, limit = 100): Promise<PaginatedResponse<UserProfile>> {
  const res = await fetch(`/api/users?page=${page}&limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to list users (status ${res.status})`);
  }
  const body = await res.json();
  return body.data as PaginatedResponse<UserProfile>;
}
