import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DashboardApp } from "./components/DashboardApp";
import "./styles.css";

// The admin operations dashboard is the same bundle served on a separate
// surface: the dashboard.rulix.cloud subdomain, or any /dashboard path.
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

const dashboardSurface = isDashboardSurface();
const Root = dashboardSurface ? DashboardApp : App;

document.title = dashboardSurface ? "Rulix Dash" : "Rulix ECCN";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

