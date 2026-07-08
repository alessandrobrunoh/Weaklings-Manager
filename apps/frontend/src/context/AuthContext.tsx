"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSession, logout as logoutService, type User } from "@/services/authService";

// Re-exported so existing `import { User } from "@/context/AuthContext"` keeps working.
export type { User };

interface AuthContextType {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  highestRole: string;
  can: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetchSession()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    try {
      await logoutService();
    } catch (_) {}
    setUser(null);
    router.push("/");
  };

  // roles[0] is the highest-priority role (backend returns them ordered).
  const highestRole = user?.roles[0] ?? "User";

  const can = (...roles: string[]) => {
    if (!user) return false;
    return roles.some((r) => r.toLowerCase() === highestRole.toLowerCase());
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, highestRole, can }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to consume the authentication context.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
