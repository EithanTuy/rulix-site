import { Building2, Download, LogOut, Plus, UserRound } from "lucide-react";
import type { UserProfile } from "../types";
import { BrandLogo } from "./BrandLogo";
import { ThemeToggle } from "./ThemeToggle";

interface TopBarProps {
  tenant: string;
  user: UserProfile;
  syncNotice: string;
  signoffReady: boolean;
  exportNotice: string;
  onNewReview: () => void;
  onExport: () => void;
  onSignoff: () => void;
  onSignOut: () => void;
}

export function TopBar({
  tenant,
  user,
  syncNotice,
  signoffReady,
  exportNotice,
  onNewReview,
  onExport,
  onSignoff,
  onSignOut
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand-block">
        <BrandLogo tone="light" size="topbar" product="ECCN" />
      </div>
      <div className="tenant-switch" aria-label="Current tenant">
        <Building2 className="tenant-icon" size={18} strokeWidth={1.9} />
        {tenant}
      </div>
      <div className="topbar-actions">
        <button className="button primary" type="button" onClick={onNewReview}>
          <Plus size={17} />
          New Review
        </button>
        <button className="button ghost" type="button" onClick={onExport}>
          <Download size={17} />
          Export Report
        </button>
        {exportNotice && <span className="export-state">{exportNotice}</span>}
        <button
          className={signoffReady ? "button ghost ready" : "button ghost"}
          type="button"
          onClick={onSignoff}
        >
          <UserRound size={17} />
          Human Signoff
          {!signoffReady && <span className="notification-dot" />}
        </button>
      </div>
      <div className="account-cluster" aria-label="Current account">
        <span>{syncNotice}</span>
        <ThemeToggle className="theme-toggle--topbar" />
        <div className="avatar">{initials(user.name)}</div>
        <button className="icon-button" type="button" aria-label="Sign out" title={`Sign out ${user.email}`} onClick={onSignOut}>
          <LogOut size={17} />
        </button>
      </div>
    </header>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "RU";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}
