import { Building2, Download, Plus, ShieldCheck, UserRound } from "lucide-react";

interface TopBarProps {
  tenant: string;
  signoffReady: boolean;
  exportNotice: string;
  onNewReview: () => void;
  onExport: () => void;
}

export function TopBar({
  tenant,
  signoffReady,
  exportNotice,
  onNewReview,
  onExport
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <ShieldCheck size={26} strokeWidth={1.9} />
        </div>
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
        >
          <UserRound size={17} />
          Human Signoff
          {!signoffReady && <span className="notification-dot" />}
        </button>
      </div>
      <div className="avatar" aria-label="Current user">
        JW
      </div>
    </header>
  );
}
