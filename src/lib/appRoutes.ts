import type { AppView } from "../types";

export type ReviewSection = "overview" | "memo" | "analysis" | "conversation" | "activity";

export type AppRoute =
  | { view: "home" }
  | { view: "reviews"; memoId?: string; section?: ReviewSection }
  | { view: "memo-builder"; sessionId?: string }
  | { view: Exclude<AppView, "home" | "reviews" | "memo-builder"> };

const simpleViews = new Set<AppView>(["controls", "evidence", "corpus", "users", "settings"]);
const reviewSections = new Set<ReviewSection>(["overview", "memo", "analysis", "conversation", "activity"]);

export function parseAppHash(hash: string): AppRoute {
  const path = hash.replace(/^#\/?/, "").split("?")[0];
  const [first = "home", second, third] = path.split("/").map(decodeSafe);
  if (first === "reviews") {
    return {
      view: "reviews",
      ...(second ? { memoId: second } : {}),
      ...(third && reviewSections.has(third as ReviewSection) ? { section: third as ReviewSection } : {})
    };
  }
  if (first === "memo-builder") {
    return { view: "memo-builder", ...(second ? { sessionId: second } : {}) };
  }
  if (simpleViews.has(first as AppView)) return { view: first as AppRoute["view"] } as AppRoute;
  return { view: "home" };
}

export function appRouteHash(route: AppRoute) {
  if (route.view === "reviews") {
    return route.memoId
      ? `#/reviews/${encodeURIComponent(route.memoId)}/${route.section ?? "overview"}`
      : "#/reviews";
  }
  if (route.view === "memo-builder") {
    return route.sessionId ? `#/memo-builder/${encodeURIComponent(route.sessionId)}` : "#/memo-builder";
  }
  return `#/${route.view}`;
}

export function navigateApp(route: AppRoute, replace = false) {
  const hash = appRouteHash(route);
  if (window.location.hash === hash) return;
  if (replace) window.history.replaceState(null, "", hash);
  else window.history.pushState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
