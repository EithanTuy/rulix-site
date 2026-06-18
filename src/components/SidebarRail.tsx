import {
  BarChart3,
  BookOpen,
  FileText,
  Settings,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import type { AppView, UserProfile } from "../types";

interface NavItem {
  icon: typeof FileText;
  label: string;
  view: AppView;
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { icon: FileText, label: "Reviews", view: "reviews" },
  { icon: BarChart3, label: "Evidence", view: "evidence" },
  { icon: BookOpen, label: "Sources", view: "corpus" },
  { icon: ShieldCheck, label: "Controls", view: "controls" },
  { icon: UsersRound, label: "Users", view: "users", adminOnly: true },
  { icon: Settings, label: "Settings", view: "settings" }
] as const;

interface SidebarRailProps {
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  userRole?: UserProfile["role"];
}

export function SidebarRail({ activeView, onViewChange, userRole }: SidebarRailProps) {
  const visibleItems = navItems.filter((item) => !item.adminOnly || userRole === "export-control-officer");

  return (
    <nav className="side-rail" aria-label="Primary">
      <div className="rail-items">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              className={activeView === item.view ? "rail-button active" : "rail-button"}
              aria-label={item.label}
              title={item.label}
              key={item.label}
              onClick={() => onViewChange(item.view)}
            >
              <Icon size={22} strokeWidth={1.8} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
