// Layout.tsx - top nav + footer shell around all routed pages.

import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

type BrandProps = {
  variant?: "dark" | "light";
  compact?: boolean;
};

export function Brand({ variant = "dark", compact = false }: BrandProps) {
  return (
    <span className={`brand ${variant === "light" ? "brand-light" : ""}`}>
      <img src="/brand/rulix-mark.png" alt="" className="brand-mark" />
      {!compact && (
        <span className="brand-word">
          rulix<span />
        </span>
      )}
    </span>
  );
}

const NAV = [
  { to: "/#outcome", label: "Outcome" },
  { to: "/#methodology", label: "Methodology" },
  { to: "/#proof", label: "Proof" },
  { to: "/#faq", label: "FAQ" },
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
    <div className="flex min-h-screen flex-col bg-bg text-text-1">
      <header className="site-header">
        <div className="wrap flex min-h-[76px] items-center justify-between gap-5 py-3">
          <Link to="/" aria-label="Rulix home">
            <Brand />
          </Link>
          <nav className="flex items-center gap-7 text-[13.5px] font-medium text-text-2 max-lg:gap-5">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} className="transition-colors hover:text-text-1 max-md:hidden">
                {item.label}
              </Link>
            ))}
            <a href="https://app.rulix.cloud" className="transition-colors hover:text-text-1 max-sm:hidden">
              Sign in
            </a>
            <Link to="/#lead" className="btn primary !py-2.5 !text-[13px]">
              Book consult
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="site-footer">
        <div className="wrap grid gap-10 py-12 md:grid-cols-[1.2fr_0.75fr_0.75fr_0.9fr]">
          <div>
            <Brand variant="light" />
            <p className="mt-5 max-w-[42ch] text-[13px] leading-6 text-white/58">
              Rulix is decision-support software for export-control review teams. It never issues final ECCN, license, sanctions, or jurisdiction determinations.
            </p>
          </div>
          <FooterColumn
            title="Product"
            links={[
              ["Overview", "/#product"],
              ["Methodology", "/#methodology"],
              ["Proof", "/#proof"],
              ["FAQ", "/#faq"],
              ["Hosted app", "https://app.rulix.cloud"],
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              ["Security", "/security"],
              ["Contact", "/contact"],
              ["Legal", "/legal"],
            ]}
          />
          <div className="border-l border-white/14 pl-7 max-md:border-l-0 max-md:pl-0">
            <h4 className="footer-title">Hosted app</h4>
            <p className="m-0 max-w-[26ch] text-[13px] leading-6 text-white/58">
              Run audits in the isolated hosted environment.
            </p>
            <a href="https://app.rulix.cloud" className="mt-5 inline-flex items-center gap-2 text-[13px] font-semibold text-accent">
              Open app
              <ArrowUpRight size={15} />
            </a>
          </div>
        </div>
        <div className="border-t border-white/10 py-5">
          <p className="wrap m-0 flex flex-wrap items-center justify-between gap-3 text-[12px] text-white/48">
            <span>(c) {new Date().getFullYear()} Rulix. Research-grade prototype.</span>
            <span>Sanitized, public, or approved input only.</span>
          </p>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <div>
      <h4 className="footer-title">{title}</h4>
      <ul className="m-0 list-none space-y-2 p-0 text-[13px] text-white/58">
        {links.map(([label, href]) => (
          <li key={href}>
            {href.startsWith("http") ? (
              <a href={href} className="hover:text-white">{label}</a>
            ) : (
              <Link to={href} className="hover:text-white">{label}</Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
