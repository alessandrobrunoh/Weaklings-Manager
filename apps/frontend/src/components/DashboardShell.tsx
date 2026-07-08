"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

interface SidebarItem {
  name: string;
  href: string;
  comingSoon?: boolean;
}

interface SidebarGroup {
  title: string;
  items: SidebarItem[];
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user, logout, highestRole } = useAuth();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [guildExpanded, setGuildExpanded] = useState(true);
  const [buildsExpanded, setBuildsExpanded] = useState(true);
  const [showSoonToast, setShowSoonToast] = useState<string | null>(null);

  const handleComingSoon = (name: string) => {
    setShowSoonToast(name);
    setTimeout(() => {
      setShowSoonToast(null);
    }, 3000);
  };

  const sidebarGroups: SidebarGroup[] = [
    {
      title: "GUILD",
      items: [
        { name: "Applications", href: "/applications", comingSoon: true },
        { name: "Members", href: "/members", comingSoon: true },
        { name: "Giveaways", href: "/giveaways", comingSoon: true },
        { name: "Rewards", href: "/rewards", comingSoon: true },
        { name: "Leaderboards", href: "/leaderboards", comingSoon: true },
        { name: "Balance", href: "/bank" },
        { name: "All Events", href: "/events" },
        { name: "Loot Split", href: "/split" },
      ],
    },
    {
      title: "BUILDS & COMPS",
      items: [
        { name: "Builds", href: "/builds", comingSoon: true },
        { name: "Comps", href: "/comps" },
        { name: "Battles", href: "/battles" },
      ],
    },
  ];

  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  const displayName = user?.username || "Anonymous Weakling";
  const avatarUrl = user?.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : "/assets/images/Discord-Symbol-White.png";

  return (
    <div className="min-h-screen flex bg-workspace text-foreground">
      {/* Toast Notification for coming soon features */}
      {showSoonToast && (
        <div className="fixed bottom-4 right-4 z-50 bg-sidebar border border-gold/40 text-foreground px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-bounce">
          <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm font-semibold">{showSoonToast} is coming soon!</span>
        </div>
      )}

      {/* Sidebar Container */}
      <aside className={`w-[260px] bg-sidebar flex-none border-r border-border-dark flex flex-col justify-between transition-all duration-300 md:translate-x-0 ${
        sidebarOpen ? "translate-x-0 fixed z-30 h-full" : "-translate-x-full fixed md:relative z-30 h-full"
      }`}>
        <div className="flex flex-col overflow-y-auto flex-1">
          {/* Logo Section */}
          <div className="p-6 flex items-center gap-3 border-b border-border-dark">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-border-dark">
              <svg className="w-6 h-6 text-gold" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h4l3 3 3-3h4c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 14.5l-3.5 2 1-3.9-3-2.7 4-.3 1.5-3.6 1.5 3.6 4 .3-3 2.7 1 3.9-3.5-2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-black tracking-widest text-gold font-serif">ALBION</h2>
              <p className="text-[10px] tracking-widest text-gray-accent font-semibold">GUILD KEEPER</p>
            </div>
          </div>

          {/* Navigation Section */}
          <nav className="p-4 space-y-6 flex-1">
            {/* Root Items */}
            <div className="space-y-1">
              <Link
                href="/dashboard"
                className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition ${
                  isActive("/dashboard")
                    ? "bg-white/5 text-white font-semibold border-l-2 border-gold"
                    : "text-gray-accent hover:text-white hover:bg-white/5"
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" />
                </svg>
                Dashboard
              </Link>
              <Link
                href="/profile"
                className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition ${
                  isActive("/profile")
                    ? "bg-white/5 text-white font-semibold border-l-2 border-gold"
                    : "text-gray-accent hover:text-white hover:bg-white/5"
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
                Settings
              </Link>
            </div>

            {/* Guild Group */}
            <div className="space-y-2">
              <button
                onClick={() => setGuildExpanded(!guildExpanded)}
                className="w-full flex items-center justify-between px-3 py-1 text-xs font-bold tracking-wider text-gold hover:text-gold-hover"
              >
                <span>GUILD</span>
                <svg className={`w-3 h-3 transform transition-transform ${guildExpanded ? "rotate-0" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {guildExpanded && (
                <div className="space-y-1 pl-2">
                  {sidebarGroups[0].items.map((item) =>
                    item.comingSoon ? (
                      <button
                        key={item.name}
                        onClick={() => handleComingSoon(item.name)}
                        className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs font-medium text-gray-accent hover:text-white hover:bg-white/5 transition text-left"
                      >
                        <span>{item.name}</span>
                        <span className="text-[9px] bg-gold/10 text-gold px-1.5 py-0.5 rounded-full uppercase tracking-wider font-semibold scale-90 origin-right">Soon</span>
                      </button>
                    ) : (
                      <Link
                        key={item.name}
                        href={item.href}
                        className={`block px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                          isActive(item.href)
                            ? "bg-white/5 text-white font-semibold"
                            : "text-gray-accent hover:text-white hover:bg-white/5"
                        }`}
                      >
                        {item.name}
                      </Link>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Builds & Comps Group */}
            <div className="space-y-2">
              <button
                onClick={() => setBuildsExpanded(!buildsExpanded)}
                className="w-full flex items-center justify-between px-3 py-1 text-xs font-bold tracking-wider text-gold hover:text-gold-hover"
              >
                <span>BUILDS & COMPS</span>
                <svg className={`w-3 h-3 transform transition-transform ${buildsExpanded ? "rotate-0" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {buildsExpanded && (
                <div className="space-y-1 pl-2">
                  {sidebarGroups[1].items.map((item) =>
                    item.comingSoon ? (
                      <button
                        key={item.name}
                        onClick={() => handleComingSoon(item.name)}
                        className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs font-medium text-gray-accent hover:text-white hover:bg-white/5 transition text-left"
                      >
                        <span>{item.name}</span>
                        <span className="text-[9px] bg-gold/10 text-gold px-1.5 py-0.5 rounded-full uppercase tracking-wider font-semibold scale-90 origin-right">Soon</span>
                      </button>
                    ) : (
                      <Link
                        key={item.name}
                        href={item.href}
                        className={`block px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                          isActive(item.href)
                            ? "bg-white/5 text-white font-semibold"
                            : "text-gray-accent hover:text-white hover:bg-white/5"
                        }`}
                      >
                        {item.name}
                      </Link>
                    )
                  )}
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* User Quick Info */}
        <div className="p-4 border-t border-border-dark bg-black/20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={avatarUrl} alt="User Avatar" className="w-8 h-8 rounded-full border border-gold/40 object-cover" referrerPolicy="no-referrer" />
            <div className="max-w-[120px] truncate">
              <p className="text-xs font-bold text-white truncate">{displayName}</p>
              <p className="text-[10px] text-gray-accent truncate">{highestRole}</p>
            </div>
          </div>
          <button onClick={logout} className="text-red-accent hover:text-red-accent-hover transition p-1.5 rounded-lg hover:bg-white/5" title="Logout">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main Container */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header Bar */}
        <header className="h-[73px] bg-header border-b border-border-dark flex items-center justify-between px-6 z-10 sticky top-0">
          <div className="flex items-center gap-4">
            {/* Mobile Sidebar Toggle */}
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden text-foreground hover:text-gold transition">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            {/* Guild Selector Dropdown */}
            <div className="relative group">
              <button className="flex items-center gap-3 bg-white/5 border border-border-dark hover:border-gold/30 hover:bg-white/10 px-4 py-2 rounded-xl text-xs font-semibold tracking-wide text-white transition cursor-pointer">
                <div className="w-4 h-4 rounded-full bg-red-accent/20 flex items-center justify-center border border-red-accent">
                  <svg className="w-2.5 h-2.5 text-red-accent" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </div>
                <span>CURRENT GUILD: <span className="text-gray-accent font-medium">NO GUILD SELECTED</span></span>
                <svg className="w-3 h-3 text-gray-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Notification Bell */}
            <button className="p-2 rounded-xl bg-white/5 border border-border-dark hover:border-gold/30 hover:text-white text-gray-accent transition cursor-pointer relative">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {/* Notification dot */}
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-gold"></span>
            </button>

            {/* Quick Profile Dropdown */}
            <Link href="/profile" className="flex items-center gap-2 hover:opacity-80 transition cursor-pointer">
              <img src={avatarUrl} alt="Quick Profile" className="w-8 h-8 rounded-full border border-gold/40 object-cover" referrerPolicy="no-referrer" />
              <svg className="w-3 h-3 text-gray-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </Link>
          </div>
        </header>

        {/* Content Viewport */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8 bg-workspace">
          {children}
        </main>
      </div>

      {/* Overlay for mobile sidebar */}
      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 bg-black/60 z-20 md:hidden"></div>
      )}
    </div>
  );
}
