import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { formatShortcut, primaryModifier } from "../../lib/keyboard";

export interface ContextMenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  tone?: "default" | "danger";
  separatorBefore?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  label: string;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export function ContextMenu({ open, x, y, label, actions, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const position = useMemo(() => ({
    left: Math.max(12, Math.min(x, window.innerWidth - 292)),
    top: Math.max(12, Math.min(y, window.innerHeight - Math.min(560, 76 + actions.length * 42)))
  }), [actions.length, x, y]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const close = (event: Event) => {
      if (menu?.contains(event.target as Node)) return;
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...(menu?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown"
        ? (index + 1 + items.length) % items.length
        : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", keydown);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, true);
    window.addEventListener("touchmove", onClose, true);
    window.addEventListener("hashchange", onClose);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("touchmove", onClose, true);
      window.removeEventListener("hashchange", onClose);
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="px-context-menu"
      role="menu"
      aria-label={label}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="px-context-search" aria-hidden="true">
        <span>Quick actions</span>
        <kbd>{primaryModifier()} K</kbd>
      </div>
      <div className="px-context-actions">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`px-context-action${action.tone === "danger" ? " danger" : ""}${action.separatorBefore ? " separated" : ""}`}
              disabled={action.disabled}
              onClick={() => {
                action.onSelect();
                onClose();
              }}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{action.label}</span>
              {action.shortcut ? <kbd>{formatShortcut(action.shortcut)}</kbd> : null}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
