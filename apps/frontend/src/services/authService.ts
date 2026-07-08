/**
 * Details of the authenticated Discord user.
 */
export interface User {
  /// The unique Snowflake ID of the Discord user.
  id: string;
  /// The username of the user.
  username: string;
  /// The registered email address of the user.
  email?: string;
  /// The avatar hash of the user.
  avatar?: string;
  /// The Discord roles the user has, ordered by priority descending.
  /// The first element is the highest-priority role.
  roles: string[];
  /// The internal database primary key of the user, used by bank/split endpoints.
  user_id: number;
}


/**
 * Fetches the current authenticated user session.
 * @returns The user, or null if not authenticated.
 */
export async function fetchSession(): Promise<User | null> {
  const res = await fetch("/api/auth/me");
  if (!res.ok) return null;
  const data = await res.json();
  return data.data as User;
}

/**
 * Logs the user out by invalidating the session server-side.
 */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
