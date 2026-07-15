import type { ReactNode } from "react";
import { safeExternalUrl } from "../lib/externalUrl";

interface SafeExternalLinkProps {
  children: ReactNode;
  className?: string;
  href: unknown;
}

export function SafeExternalLink({ children, className, href }: SafeExternalLinkProps) {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) return <span className={className}>{children}</span>;
  return (
    <a
      className={className}
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      {children}
    </a>
  );
}
