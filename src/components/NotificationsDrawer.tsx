import { useEffect, useState } from "react";
import { Bell, CheckCheck, MessageSquareText, UserRoundCheck, X } from "lucide-react";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../lib/apiClient";
import type { WorkspaceNotification } from "../types";

interface NotificationsDrawerProps {
  open: boolean;
  onClose: () => void;
  onUnreadChange: (count: number) => void;
  onOpenReview: (memoId: string) => void;
}

export function NotificationsDrawer({ open, onClose, onUnreadChange, onOpenReview }: NotificationsDrawerProps) {
  const [items, setItems] = useState<WorkspaceNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void listNotifications({ limit: 50 }, controller.signal)
      .then((page) => {
        setItems(page.items);
        onUnreadChange(page.items.filter((item) => !item.readAt).length);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Notifications could not be loaded.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [onUnreadChange, open]);

  if (!open) return null;
  const markOne = async (notification: WorkspaceNotification) => {
    if (!notification.readAt) {
      const updated = await markNotificationRead(notification.id);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      onUnreadChange(items.filter((item) => !item.readAt && item.id !== notification.id).length);
    }
    if (notification.memoId) onOpenReview(notification.memoId);
    onClose();
  };
  const markAll = async () => {
    const result = await markAllNotificationsRead();
    setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt: result.readAt }));
    onUnreadChange(0);
  };
  return (
    <div className="px-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="px-notification-drawer" role="dialog" aria-modal="true" aria-labelledby="notification-title">
        <header>
          <div><p className="px-eyebrow">Inbox</p><h2 id="notification-title">Notifications</h2></div>
          <button type="button" className="px-icon-button" onClick={onClose} aria-label="Close notifications"><X size={20} /></button>
        </header>
        <div className="px-notification-toolbar">
          <span>{items.filter((item) => !item.readAt).length} unread</span>
          <button type="button" onClick={() => void markAll()} disabled={!items.some((item) => !item.readAt)}><CheckCheck size={16} />Mark all read</button>
        </div>
        <div className="px-notification-list">
          {loading ? <div className="px-skeleton-stack" aria-label="Loading notifications"><span /><span /><span /></div> : null}
          {error ? <div className="px-inline-error"><strong>Notifications unavailable</strong><span>{error}</span></div> : null}
          {!loading && !error && items.length === 0 ? (
            <div className="px-empty-state compact"><Bell size={24} /><h3>You’re all caught up</h3><p>Assignments, mentions, due dates, and decisions will appear here.</p></div>
          ) : null}
          {items.map((item) => {
            const Icon = item.kind === "assignment" ? UserRoundCheck : MessageSquareText;
            return (
              <button type="button" className={`px-notification${item.readAt ? "" : " unread"}`} key={item.id} onClick={() => void markOne(item)}>
                <span className="px-notification-icon"><Icon size={17} /></span>
                <span><strong>{item.title}</strong><span>{item.detail}</span><time>{relativeTime(item.createdAt)}</time></span>
                {!item.readAt ? <i aria-label="Unread" /> : null}
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
