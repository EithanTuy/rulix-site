import { useEffect, useRef, useState } from "react";
import { Bell, Building2, ChevronDown, CircleHelp, LogOut, Menu, Search, Settings, UserRound } from "lucide-react";
import type { UserProfile } from "../types";
import { primaryModifier } from "../lib/keyboard";
import { BrandLogo } from "./BrandLogo";
import { ThemeToggle } from "./ThemeToggle";

interface TopBarProps {
  tenant: string;
  user: UserProfile;
  systemStatus: string;
  unreadNotifications: number;
  onSearch: () => void;
  onNotifications: () => void;
  onHelp: () => void;
  onSettings: () => void;
  onMobileMenu: () => void;
  onSignOut: () => void;
}

export function TopBar({
  tenant,
  user,
  systemStatus,
  unreadNotifications,
  onSearch,
  onNotifications,
  onHelp,
  onSettings,
  onMobileMenu,
  onSignOut
}: TopBarProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!accountOpen) return;
    const close = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [accountOpen]);

  return (
    <header className="px-topbar">
      <button className="px-mobile-menu" type="button" onClick={onMobileMenu} aria-label="Open navigation"><Menu size={21} /></button>
      <div className="px-brand-block"><BrandLogo tone="light" size="topbar" product="ECCN" /></div>
      <div className="px-tenant" aria-label={`Organization: ${tenant}`}>
        <Building2 size={17} strokeWidth={1.8} />
        <span>{tenant}</span>
      </div>
      <button className="px-global-search" type="button" onClick={onSearch} aria-label="Open command search">
        <Search size={18} />
        <span>Search reviews, memos, cases…</span>
        <kbd>{primaryModifier()} K</kbd>
      </button>
      <div className="px-topbar-tools">
        <span className="px-system-status"><i />{systemStatus}</span>
        <button type="button" className="px-topbar-button" onClick={onHelp} aria-label="Help"><CircleHelp size={19} /><span>Help</span></button>
        <button type="button" className="px-topbar-button icon-only" onClick={onNotifications} aria-label={`Notifications, ${unreadNotifications} unread`}>
          <Bell size={19} />
          {unreadNotifications > 0 ? <b>{Math.min(99, unreadNotifications)}</b> : null}
        </button>
        <div className="px-account" ref={accountRef}>
          <button type="button" className="px-account-trigger" onClick={() => setAccountOpen((value) => !value)} aria-expanded={accountOpen}>
            <span className="px-avatar">{initials(user.name)}</span>
            <span><strong>{user.name}</strong><small>{roleLabel(user.role)}</small></span>
            <ChevronDown size={16} />
          </button>
          {accountOpen ? (
            <div className="px-account-menu" role="menu">
              <div><strong>{user.name}</strong><span>{user.email}</span></div>
              <button type="button" role="menuitem" onClick={() => { setAccountOpen(false); onSettings(); }}><Settings size={16} />Workspace settings</button>
              <ThemeToggle className="px-account-theme" />
              <button type="button" role="menuitem" onClick={onSignOut}><LogOut size={16} />Sign out</button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "RU";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function roleLabel(role: UserProfile["role"]) {
  if (role === "export-control-officer") return "Export-control officer";
  return role[0].toUpperCase() + role.slice(1);
}
