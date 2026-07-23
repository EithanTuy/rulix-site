import type { AppView } from "../types";

export type ReviewStage = "prepare" | "review" | "decide";
export type ReviewPanel = "details" | "sources" | "comments" | "chat" | "activity";

export type AppRoute =
  | { view: "work"; memoId?: string; stage?: ReviewStage; panel?: ReviewPanel }
  | { view: "memo-builder"; sessionId?: string }
  | { view: Exclude<AppView, "work" | "memo-builder"> };

const simpleViews = new Set<AppView>(["controls", "evidence", "corpus", "users", "settings"]);
const reviewStages = new Set<ReviewStage>(["prepare", "review", "decide"]);
const reviewPanels = new Set<ReviewPanel>(["details", "sources", "comments", "chat", "activity"]);

const legacySectionAliases: Record<string, { stage: ReviewStage; panel?: ReviewPanel }> = {
  memo: { stage: "prepare" },
  overview: { stage: "review" },
  analysis: { stage: "review" },
  conversation: { stage: "review", panel: "chat" },
  activity: { stage: "review", panel: "activity" }
};

export function parseAppHash(hash: string): AppRoute {
  const [rawPath, rawQuery = ""] = hash.replace(/^#\/?/, "").split("?");
  const [first = "work", second, third] = rawPath.split("/").map(decodeSafe);
  if (first === "reviews") {
    if (!second) return { view: "work" };
    const alias = third ? legacySectionAliases[third] : undefined;
    const stage = reviewStages.has(third as ReviewStage) ? third as ReviewStage : alias?.stage ?? "review";
    const queryPanel = new URLSearchParams(rawQuery).get("panel");
    const panel = reviewPanels.has(queryPanel as ReviewPanel)
      ? queryPanel as ReviewPanel
      : alias?.panel;
    return {
      view: "work",
      memoId: second,
      stage,
      ...(panel ? { panel } : {})
    };
  }
  if (first === "home" || first === "work" || !first) return { view: "work" };
  if (first === "memo-builder") {
    return { view: "memo-builder", ...(second ? { sessionId: second } : {}) };
  }
  if (simpleViews.has(first as AppView)) return { view: first as AppRoute["view"] } as AppRoute;
  return { view: "work" };
}

export function appRouteHash(route: AppRoute) {
  if (route.view === "work") {
    if (!route.memoId) return "#/work";
    const panel = route.panel ? `?panel=${encodeURIComponent(route.panel)}` : "";
    return `#/reviews/${encodeURIComponent(route.memoId)}/${route.stage ?? "review"}${panel}`;
  }
  if (route.view === "memo-builder") {
    return route.sessionId ? `#/memo-builder/${encodeURIComponent(route.sessionId)}` : "#/memo-builder";
  }
  return `#/${route.view}`;
}

export function normalizeAppHash(hash?: string) {
  return appRouteHash(parseAppHash(hash || "#/work"));
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
