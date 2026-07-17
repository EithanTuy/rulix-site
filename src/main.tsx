import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { applyTheme, getInitialTheme } from "./components/ThemeToggle";
import "./styles.css";

// The public site, app, and operations dashboard share one bundle. Hostname is
// authoritative in production; paths keep local development and previews easy.
function isDashboardSurface() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  // Primary: the dashboard.rulix.cloud subdomain. Secondary: any /dashboard
  // path segment (base-path agnostic, e.g. "/dashboard" or "/app/dashboard").
  return (
    host === "dashboard.rulix.cloud" ||
    host.startsWith("dashboard.") ||
    /(^|\/)dashboard(\/|$)/.test(window.location.pathname)
  );
}

function isAppSurface() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  return (
    host === "app.rulix.cloud" ||
    host.startsWith("app.") ||
    /(^|\/)(app|workspace|reviews)(\/|$)/.test(window.location.pathname)
  );
}

const dashboardSurface = isDashboardSurface();
const appSurface = isAppSurface();
document.title = dashboardSurface ? "Rulix Dash" : appSurface ? "Rulix ECCN" : "Rulix";
applyTheme(getInitialTheme());

const AppSurface = lazy(() => import("./App").then((module) => ({
  default: function RulixAppSurface() {
    return <module.App authLink={module.consumeAuthLinkFragment()} />;
  }
})));
const DashboardSurface = lazy(() => import("./components/DashboardApp").then((module) => ({ default: module.DashboardApp })));
const MarketingSurface = lazy(() => import("./components/MarketingSite").then((module) => ({ default: module.MarketingSite })));

const root = dashboardSurface
  ? <DashboardSurface />
  : appSurface
    ? <AppSurface />
    : <MarketingSurface />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="surface-loader" role="status" aria-live="polite"><span />Loading Rulix…</div>}>
      {root}
    </Suspense>
  </React.StrictMode>
);

