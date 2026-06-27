import { onCLS, onINP, onLCP, type Metric } from "web-vitals";

type Payload = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: (...args: unknown[]) => void;
  }
}

const endpoint = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_ANALYTICS_ENDPOINT;

export function trackEvent(event: string, payload: Payload = {}) {
  const body = {
    event,
    ...payload,
    path: window.location.pathname,
    ts: Date.now(),
  };

  window.dataLayer?.push(body);
  window.gtag?.("event", event, payload);

  if (endpoint && navigator.sendBeacon) {
    navigator.sendBeacon(endpoint, JSON.stringify(body));
  }
}

export function initAnalytics() {
  const report = (metric: Metric) => {
    trackEvent("web_vital", {
      metric: metric.name,
      value: metric.value,
      rating: metric.rating,
      id: metric.id,
    });
  };

  onCLS(report);
  onINP(report);
  onLCP(report);
}
