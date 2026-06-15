import {
  BarChart3,
  BookOpen,
  FileText
} from "lucide-react";
import type { AppView } from "../types";

const navItems = [
  { icon: FileText, label: "Reviews", view: "reviews" },
  { icon: BarChart3, label: "Evidence", view: "evidence" },
  { icon: BookOpen, label: "Sources", view: "corpus" }
] as const;

interface SidebarRailProps {
  activeView: AppView;
  onViewChange: (view: AppView) => void;
}

export function SidebarRail({ activeView, onViewChange }: SidebarRailProps) {
  return (
    <nav className="side-rail" aria-label="Primary">
      <div className="rail-items">
        {navItems.map((item) => {
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
