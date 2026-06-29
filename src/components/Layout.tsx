// Layout.tsx - top nav + footer shell around all routed pages.

import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

export function Brand({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="#f8fbff" />
        <path d="M8 17.2 16.2 9 24 16.8v6.6h-6.7l-3.9-3.8-3.8 3.8H8v-6.2Z" fill="#0cc9bd" />
        <path d="M14.1 21.1 8.7 15.7 12 12.3l5.5 5.5h5.8v5.8h-6.1l-3.1-2.5Z" fill="#111827" />
      </svg>
      <strong className="text-[24px] font-semibold tracking-tight text-white">rulix</strong>
    </span>
  );
}

const NAV = [
  { to: "/#product-demo", label: "Product" },
  { to: "/#review-loop", label: "Review loop" },
  { to: "/#fit-check", label: "Fit check" },
];

export function Layout() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      window.setTimeout(() => {
        document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
      }, 0);
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("vis")),
      { threshold: 0.12 },
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);

  return (
    <div className="site-shell flex min-h-screen flex-col">
      <header className="site-header">
        <div className="site-wrap flex min-h-[58px] items-center justify-between gap-5">
          <Link to="/" aria-label="Rulix home"><Brand /></Link>
          <nav className="flex items-center gap-7 text-[13px] font-bold text-text-2 max-md:gap-4">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} className="transition-colors hover:text-text-1 max-sm:hidden">
                {item.label}
              </Link>
            ))}
            <a href="https://app.rulix.cloud" className="transition-colors hover:text-text-1 max-md:hidden">
              Sign in
            </a>
            <Link to="/contact" className="site-button site-button-primary !min-h-[42px] !px-5 !text-[13px]">Request access</Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="site-footer">
        <div className="site-wrap grid gap-8 py-12 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Brand size={24} />
            <p className="footnote mt-4 max-w-[44ch]">
              Export-control memo review with human signoff. Rulix supports qualified reviewers;
              it does not replace final legal or compliance judgment.
            </p>
          </div>
          <div className="text-[13.5px]">
            <h4 className="mb-3 text-[12px] uppercase tracking-[0.1em] text-text-3">Product</h4>
            <ul className="m-0 list-none space-y-2 p-0 text-text-2">
              <li><Link to="/#product-demo" className="hover:text-text-1">Product in action</Link></li>
              <li><Link to="/#review-loop" className="hover:text-text-1">Review loop</Link></li>
              <li><Link to="/#fit-check" className="hover:text-text-1">Fit check</Link></li>
              <li><Link to="/security" className="hover:text-text-1">Security and data handling</Link></li>
              <li><a href="https://app.rulix.cloud" className="hover:text-text-1">Hosted app</a></li>
            </ul>
          </div>
          <div className="text-[13.5px]">
            <h4 className="mb-3 text-[12px] uppercase tracking-[0.1em] text-text-3">Company</h4>
            <ul className="m-0 list-none space-y-2 p-0 text-text-2">
              <li><Link to="/legal" className="hover:text-text-1">Legal and disclaimer</Link></li>
              <li><Link to="/contact" className="hover:text-text-1">Contact</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-line-soft py-5">
          <p className="site-wrap footnote m-0">
            (c) {new Date().getFullYear()} Rulix. Sanitized, public, or
            approved input only. Do not submit CUI, ITAR technical data, or controlled information.
          </p>
        </div>
      </footer>
    </div>
  );
}
