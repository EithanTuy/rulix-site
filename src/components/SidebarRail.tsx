import {
  BookOpen,
  FileText,
  Home,
  Library,
  Settings,
  ShieldCheck,
  UsersRound,
  Wand2,
  X
} from "lucide-react";
import type { AppView, UserProfile } from "../types";

interface NavItem {
  icon: typeof FileText;
  label: string;
  view: AppView;
  roles?: UserProfile["role"][];
}

const navItems: NavItem[] = [
  { icon: Home, label: "Home / My Work", view: "home" },
  { icon: FileText, label: "Reviews", view: "reviews" },
  { icon: Wand2, label: "Memo Builder", view: "memo-builder" },
  { icon: Library, label: "Evidence Library", view: "evidence" },
  { icon: BookOpen, label: "Sources", view: "corpus", roles: ["reviewer", "counsel", "export-control-officer"] },
  { icon: ShieldCheck, label: "Controls", view: "controls", roles: ["reviewer", "counsel", "export-control-officer"] },
  { icon: UsersRound, label: "Administration", view: "users", roles: ["export-control-officer"] },
  { icon: Settings, label: "Settings", view: "settings", roles: ["export-control-officer"] }
];

interface SidebarRailProps {
  activeView: AppView;
  userRole: UserProfile["role"];
  mobileOpen: boolean;
  serviceReady: boolean;
  onViewChange: (view: AppView) => void;
  onMobileClose: () => void;
}

export function SidebarRail({ activeView, userRole, mobileOpen, serviceReady, onViewChange, onMobileClose }: SidebarRailProps) {
  return (
    <>
      {mobileOpen ? <button className="px-nav-backdrop" type="button" aria-label="Close navigation" onClick={onMobileClose} /> : null}
      <nav className={`px-sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label="Primary">
        <div className="px-sidebar-mobile-head"><strong>Navigate</strong><button type="button" onClick={onMobileClose} aria-label="Close navigation"><X size={19} /></button></div>
        <div className="px-nav-items">
          {navItems.filter((item) => !item.roles || item.roles.includes(userRole)).map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                className={activeView === item.view ? "px-nav-button active" : "px-nav-button"}
                aria-current={activeView === item.view ? "page" : undefined}
                key={item.view}
                onClick={() => { onViewChange(item.view); onMobileClose(); }}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
        <div className="px-sidebar-footer">
          <div className="px-service-card"><i className={serviceReady ? "ready" : ""} /><span><strong>Rulix service</strong><small>{serviceReady ? "Operational" : "Checking status"}</small></span></div>
          <a href="https://dashboard.rulix.cloud/">Open operator dashboard</a>
        </div>
      </nav>
    </>
  );
}
