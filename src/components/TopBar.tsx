import { Building2, Download, LogOut, Plus, UserRound } from "lucide-react";
import type { UserProfile } from "../types";

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
        <RulixMark />
        <div className="brand-name">
          <strong>Rulix</strong>
          <span>ECCN</span>
        </div>
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
        <div className="avatar">{initials(user.name)}</div>
        <button className="icon-button" type="button" aria-label="Sign out" title={`Sign out ${user.email}`} onClick={onSignOut}>
          <LogOut size={17} />
        </button>
      </div>
    </header>
  );
}

function RulixMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 44 44">
        <path d="M7 8.5h19.5c6.1 0 10.5 4 10.5 9.7 0 4-2.2 7.2-5.7 8.7L38 35.5h-8.4l-5.8-7.6h-8.9v7.6H7V8.5Zm7.9 6.6v6.5h10.7c2 0 3.3-1.3 3.3-3.2 0-2-1.3-3.3-3.3-3.3H14.9Z" />
        <path d="M15.8 23.7h9.4l4 5.3H15.8v-5.3Z" />
      </svg>
    </div>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "RU";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}
