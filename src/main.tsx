import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DashboardApp } from "./components/DashboardApp";
import { MarketingSite, isMarketingPath } from "./components/MarketingSite";
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

function isMarketingSurface() {
  if (typeof window === "undefined") return true;
  const host = window.location.hostname.toLowerCase();
  return (
    host === "rulix.cloud" ||
    host === "www.rulix.cloud" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    isMarketingPath(window.location.pathname)
  );
}

const dashboardSurface = isDashboardSurface();
const appSurface = isAppSurface();
const Root = dashboardSurface ? DashboardApp : appSurface ? App : isMarketingSurface() ? MarketingSite : MarketingSite;

document.title = dashboardSurface ? "Rulix Dash" : appSurface ? "Rulix ECCN" : "Rulix";
applyTheme(getInitialTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

