import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Contact } from "./pages/Contact";
import { Home, type LandingVariant } from "./pages/Home";
import { Legal } from "./pages/Legal";
import { Security } from "./pages/Security";
import { ThankYou } from "./pages/ThankYou";
import { initAnalytics } from "./lib/analytics";
import { applyTheme, getInitialTheme } from "./components/ThemeToggle";
import "./index.css";

const future = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
};

const seoRoutes: Array<{ path: string; variant: LandingVariant }> = [
  { path: "export-control-memo-review", variant: "memo-review" },
  { path: "eccn-classification-assistant", variant: "eccn-assistant" },
  { path: "ai-export-compliance-review", variant: "ai-review" },
  { path: "university-export-control-review", variant: "university" },
  { path: "manufacturer-eccn-review", variant: "manufacturer" },
];

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      ...seoRoutes.map((route) => ({
        path: route.path,
        element: <Home variant={route.variant} />,
      })),
      { path: "security", element: <Security /> },
      { path: "contact", element: <Contact /> },
      { path: "legal", element: <Legal /> },
      { path: "thank-you", element: <ThankYou /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
], { future });

initAnalytics();
applyTheme(getInitialTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
