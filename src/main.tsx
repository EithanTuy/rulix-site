import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { MarketingSite } from "./components/MarketingSite";
import { Contact } from "./pages/Contact";
import { Legal } from "./pages/Legal";
import { Security } from "./pages/Security";
import "./index.css";

const future = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
};

const marketingRoutes = [
  "/",
  "/export-control-memo-review",
  "/eccn-classification-assistant",
  "/ai-export-compliance-review",
  "/university-export-control-review",
  "/manufacturer-eccn-review",
];

const router = createBrowserRouter([
  ...marketingRoutes.map((path) => ({ path, element: <MarketingSite /> })),
  {
    element: <Layout />,
    children: [
      { path: "/security", element: <Security /> },
      { path: "/contact", element: <Contact /> },
      { path: "/legal", element: <Legal /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
], { future });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
