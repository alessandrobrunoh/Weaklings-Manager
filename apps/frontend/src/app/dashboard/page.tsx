"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import DashboardShell from "@/components/DashboardShell";
import {
  fetchLinkStatus,
  fetchGuildRoster,
  linkPlayer,
  unlinkPlayer,
  type AlbionLinkStatus,
  type AlbionGuildMember,
} from "@/services/albionService";
import { getBalance } from "@/services/bankService";
import Link from "next/link";

export default function Dashboard() {
  const { user, loading, highestRole, can, logout } = useAuth();
  const router = useRouter();

  const [linkStatus, setLinkStatus] = useState<AlbionLinkStatus | null>(null);
  const [roster, setRoster] = useState<AlbionGuildMember[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string>("23.000.000");

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (user) {
      fetchLinkStatus().then(setLinkStatus).catch(() => setLinkStatus(null));
      getBalance()
        .then((b) => {
          if (b && b.pending_total) {
            const val = parseFloat(b.pending_total);
            if (!isNaN(val)) {
              setBalance(val.toLocaleString("de-DE"));
            }
          }
        })
        .catch(() => {});
    }
  }, [user]);

  useEffect(() => {
    if (!user || linkStatus?.linked) return;
    const handle = setTimeout(() => {
      fetchGuildRoster(searchQuery).then(setRoster).catch(() => setRoster([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [user, linkStatus, searchQuery]);

  const handleLink = async (member: AlbionGuildMember) => {
    setLinkBusy(true);
    setLinkError(null);
    try {
      const status = await linkPlayer(member.id, member.name);
      setLinkStatus(status);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to link player");
    } finally {
      setLinkBusy(false);
    }
  };

  const handleUnlink = async () => {
    setLinkBusy(true);
    setLinkError(null);
    try {
      await unlinkPlayer();
      setLinkStatus({ linked: false });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to unlink player");
    } finally {
      setLinkBusy(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-workspace flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm font-medium text-gray-accent">Loading session...</p>
        </div>
      </div>
    );
  }

  const avatarUrl = user?.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : "/assets/images/Discord-Symbol-White.png";

  return (
    <DashboardShell>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Main Dashboard Panel */}
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-3xl border border-border-dark bg-sidebar p-6 md:p-8 shadow-xl">
            <h2 className="text-2xl font-bold tracking-tight text-white">Welcome, {user.username}!</h2>
            <p className="mt-2 text-gray-accent">
              You are logged in with the role: <span className="font-semibold text-gold">{highestRole}</span>
            </p>
            
            {can("superadmin", "admin") ? (
              <div className="mt-6 rounded-2xl border border-emerald-900/30 bg-emerald-950/20 p-4">
                <h3 className="font-semibold text-emerald-400">
                  {can("superadmin") ? "SuperAdmin Control Panel" : "Admin Control Panel"}
                </h3>
                <p className="mt-1 text-sm text-emerald-500/80">
                  {can("superadmin")
                    ? "You have full super-administrative access to the system."
                    : "You have administrative access to the system."}
                </p>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-border-dark bg-white/5 p-4">
                <h3 className="font-semibold text-white">Standard Access</h3>
                <p className="mt-1 text-sm text-gray-accent">
                  You have standard user access.
                </p>
              </div>
            )}

            {/* Albion Account Link Status */}
            <div className="mt-8 rounded-2xl border border-border-dark bg-black/20 p-6">
              <h3 className="font-semibold text-gold text-lg mb-4">Albion Online Link Status</h3>

              {linkError && (
                <div className="mb-4 bg-red-accent/10 border border-red-accent/20 text-red-accent px-4 py-2.5 rounded-xl text-sm">
                  {linkError}
                </div>
              )}

              {linkStatus?.linked ? (
                <div className="flex items-center justify-between gap-4 bg-white/5 p-4 rounded-xl border border-border-dark">
                  <div>
                    <p className="text-xs text-gray-accent">Linked Character</p>
                    <p className="text-sm font-semibold text-white mt-0.5">{linkStatus.albion_player_name}</p>
                  </div>
                  <button
                    onClick={handleUnlink}
                    disabled={linkBusy}
                    className="rounded-xl border border-border-dark bg-transparent px-4 py-2 text-xs font-semibold text-white hover:bg-white/5 hover:border-white/20 transition disabled:opacity-50 cursor-pointer"
                  >
                    Unlink
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-gray-accent mb-4">
                    Not linked to an Albion Online player character. Search the guild roster below to link your account.
                  </p>
                  <div className="relative">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search guild members..."
                      className="w-full rounded-xl border border-border-dark bg-sidebar px-4 py-3 text-sm text-white placeholder-gray-accent focus:outline-none focus:border-gold/50 transition"
                    />
                  </div>
                  <ul className="mt-4 divide-y divide-border-dark bg-sidebar/50 rounded-2xl border border-border-dark overflow-hidden max-h-60 overflow-y-auto">
                    {roster.map((member) => (
                      <li key={member.id} className="flex items-center justify-between px-4 py-3 hover:bg-white/5 transition">
                        <span className="text-sm text-white font-medium">{member.name}</span>
                        <button
                          onClick={() => handleLink(member)}
                          disabled={linkBusy}
                          className="rounded-xl bg-gold hover:bg-gold-hover px-4 py-1.5 text-xs font-bold text-black transition disabled:opacity-50 cursor-pointer"
                        >
                          Link
                        </button>
                      </li>
                    ))}
                    {roster.length === 0 && (
                      <li className="px-4 py-4 text-sm text-gray-accent text-center">No members found.</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* User Profile Card (Right Sidebar Widget) */}
        <div className="rounded-3xl border border-border-dark bg-card p-6 shadow-xl flex flex-col items-center relative overflow-hidden">
          {/* Top balance banner */}
          <div className="w-full flex items-center justify-between border-b border-border-dark pb-4 mb-6">
            <span className="text-[10px] font-bold tracking-widest text-gray-accent uppercase">In-Game Silver</span>
            <div className="flex items-center gap-1.5 bg-white/5 px-2.5 py-1 rounded-full border border-border-dark">
              <span className="text-xs font-black text-amber-500 font-serif">S</span>
              <span className="text-xs font-bold text-white font-mono">{balance}</span>
            </div>
          </div>

          {/* User Avatar */}
          <div className="relative group mb-4">
            <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-gold to-amber-300 opacity-20 blur-md group-hover:opacity-45 transition duration-300"></div>
            <img
              src={avatarUrl}
              alt="User Profile"
              className="w-24 h-24 rounded-full border-2 border-gold/40 object-cover shadow-2xl relative z-10"
              referrerPolicy="no-referrer"
            />
          </div>

          <h3 className="text-lg font-bold text-white mb-1">Welcome, {user.username}</h3>
          <p className="text-xs text-gray-accent font-medium mb-6 uppercase tracking-wider">{highestRole}</p>

          <Link
            href="/profile"
            className="w-full py-3 bg-white/5 border border-border-dark hover:border-white/20 hover:bg-white/10 text-white rounded-xl text-xs font-bold text-center transition tracking-wide uppercase mb-6 cursor-pointer"
          >
            Manage Your Account
          </Link>

          {/* Footer selectors */}
          <div className="w-full flex items-center justify-between border-t border-border-dark pt-4 text-xs">
            {/* Language Selector */}
            <div className="flex items-center gap-2 text-gray-accent cursor-pointer hover:text-white transition">
              <span className="text-base">🇺🇸</span>
              <span className="font-semibold">English</span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </div>

            {/* Logout button */}
            <button
              onClick={logout}
              className="flex items-center gap-1.5 text-red-accent hover:text-red-accent-hover transition font-semibold cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              <span>Logout</span>
            </button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
