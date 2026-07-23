import { useState } from "react";
import {
  BookOpen,
  BriefcaseBusiness,
  ChevronDown,
  ExternalLink,
  FileText,
  Library,
  ShieldCheck,
  UsersRound,
  Wand2,
  X
} from "lucide-react";
import type { AppView, UserProfile } from "../types";

interface SidebarRailProps {
  activeView: AppView;
  userRole: UserProfile["role"];
  mobileOpen: boolean;
  onViewChange: (view: AppView) => void;
  onMobileClose: () => void;
}

export function SidebarRail({
  activeView,
  userRole,
  mobileOpen,
  onViewChange,
  onMobileClose
}: SidebarRailProps) {
  const [toolsOpen, setToolsOpen] = useState(["memo-builder", "evidence", "corpus"].includes(activeView));
  const [officerOpen, setOfficerOpen] = useState(["controls", "users"].includes(activeView));
  const open = (view: AppView) => {
    onViewChange(view);
    onMobileClose();
  };

  return (
    <>
      {mobileOpen ? <button className="px-nav-backdrop" type="button" aria-label="Close navigation" onClick={onMobileClose} /> : null}
      <nav className={`px-sidebar simplified${mobileOpen ? " mobile-open" : ""}`} aria-label="Primary">
        <div className="px-sidebar-mobile-head">
          <strong>Navigate</strong>
          <button type="button" onClick={onMobileClose} aria-label="Close navigation"><X size={19} /></button>
        </div>
        <div className="px-nav-items">
          <button
            type="button"
            className={activeView === "work" ? "px-nav-button active" : "px-nav-button"}
            aria-current={activeView === "work" ? "page" : undefined}
            onClick={() => open("work")}
          >
            <FileText size={19} strokeWidth={1.8} />
            <span>Work</span>
          </button>

          <div className="px-nav-disclosure">
            <button
              type="button"
              className={["memo-builder", "evidence", "corpus"].includes(activeView) ? "px-nav-button active-parent" : "px-nav-button"}
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((current) => !current)}
            >
              <BriefcaseBusiness size={19} strokeWidth={1.8} />
              <span>Tools</span>
              <ChevronDown className={toolsOpen ? "open" : ""} size={16} />
            </button>
            {toolsOpen ? (
              <div className="px-nav-submenu">
                <SubmenuButton icon={Wand2} label="Memo Builder" view="memo-builder" activeView={activeView} onOpen={open} />
                <SubmenuButton icon={Library} label="Evidence Library" view="evidence" activeView={activeView} onOpen={open} />
                {userRole !== "submitter" ? <SubmenuButton icon={BookOpen} label="Sources" view="corpus" activeView={activeView} onOpen={open} /> : null}
              </div>
            ) : null}
          </div>

          {userRole === "export-control-officer" ? (
            <div className="px-nav-disclosure officer">
              <button
                type="button"
                className={["controls", "users"].includes(activeView) ? "px-nav-button active-parent" : "px-nav-button"}
                aria-expanded={officerOpen}
                onClick={() => setOfficerOpen((current) => !current)}
              >
                <ShieldCheck size={19} strokeWidth={1.8} />
                <span>Officer</span>
                <ChevronDown className={officerOpen ? "open" : ""} size={16} />
              </button>
              {officerOpen ? (
                <div className="px-nav-submenu">
                  <SubmenuButton icon={ShieldCheck} label="Approvals & controls" view="controls" activeView={activeView} onOpen={open} />
                  <SubmenuButton icon={UsersRound} label="Administration" view="users" activeView={activeView} onOpen={open} />
                  <a href="https://dashboard.rulix.cloud/"><ExternalLink size={16} />Operator dashboard</a>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </nav>
    </>
  );
}

function SubmenuButton({
  icon: Icon,
  label,
  view,
  activeView,
  onOpen
}: {
  icon: typeof FileText;
  label: string;
  view: AppView;
  activeView: AppView;
  onOpen: (view: AppView) => void;
}) {
  return (
    <button
      type="button"
      className={activeView === view ? "active" : ""}
      aria-current={activeView === view ? "page" : undefined}
      onClick={() => onOpen(view)}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}
