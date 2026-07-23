export type MarketingPageKind = "home" | "product" | "use-cases" | "trust" | "contact";

export type MarketingAudience = "officers" | "industry" | "research";

export interface MarketingPageMeta {
  key: string;
  path: string;
  title: string;
  description: string;
  pageKind: MarketingPageKind;
  legacyAudience?: MarketingAudience;
  canonicalPath?: string;
}

export const PRIMARY_MARKETING_NAV: ReadonlyArray<{
  label: string;
  path: string;
  pageKind: Exclude<MarketingPageKind, "home">;
}> = [
  { label: "Product", path: "/product", pageKind: "product" },
  { label: "Use Cases", path: "/use-cases", pageKind: "use-cases" },
  { label: "Trust", path: "/trust", pageKind: "trust" },
  { label: "Contact", path: "/contact", pageKind: "contact" }
];

export const MARKETING_SITE_PAGES: ReadonlyArray<MarketingPageMeta> = [
  {
    key: "home",
    path: "/",
    title: "Rulix | AI-assisted export classification",
    description:
      "Rulix helps export-control teams review classification memos, find missing support, and keep final decisions with qualified people.",
    pageKind: "home"
  },
  {
    key: "product",
    path: "/product",
    title: "How Rulix works | AI-assisted export classification",
    description:
      "See how Rulix helps reviewers find missing support, answer classification questions, and preserve a clear decision record.",
    pageKind: "product"
  },
  {
    key: "use-cases",
    path: "/use-cases",
    title: "Export classification use cases | Rulix",
    description:
      "See how export-control officers, manufacturers, labs, universities, and research teams use Rulix to prepare clearer classification reviews.",
    pageKind: "use-cases"
  },
  {
    key: "trust",
    path: "/trust",
    title: "Human review and clear records | Rulix",
    description:
      "Rulix keeps people in charge, connects findings to source material, controls workspace access, and records what changed and why.",
    pageKind: "trust"
  },
  {
    key: "contact",
    path: "/contact",
    title: "Contact Rulix",
    description:
      "Email Rulix to talk about an export classification or memo review workflow.",
    pageKind: "contact"
  },
  {
    key: "site",
    path: "/site",
    title: "Rulix | AI-assisted export classification",
    description:
      "Rulix helps export-control teams review classification memos, find missing support, and keep final decisions with qualified people.",
    pageKind: "home",
    canonicalPath: "/"
  },
  {
    key: "security",
    path: "/security",
    title: "Human review and clear records | Rulix",
    description:
      "Rulix keeps people in charge, connects findings to source material, controls workspace access, and records what changed and why.",
    pageKind: "trust",
    canonicalPath: "/trust"
  },
  {
    key: "export-control-memo-review",
    path: "/export-control-memo-review",
    title: "Export-control memo review software | Rulix",
    description:
      "Review export-control classification memos for missing support, reviewer questions, and a clear record before final signoff.",
    pageKind: "product"
  },
  {
    key: "eccn-classification-assistant",
    path: "/eccn-classification-assistant",
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps reviewers structure ECCN classification work and keep final judgment with qualified people.",
    pageKind: "product"
  },
  {
    key: "ai-export-compliance-review",
    path: "/ai-export-compliance-review",
    title: "AI-assisted export compliance review with human signoff | Rulix",
    description:
      "Use AI assistance to find missing support while trained reviewers remain responsible for the final export-control decision.",
    pageKind: "product"
  },
  {
    key: "university-export-control-review",
    path: "/university-export-control-review",
    title: "University export-control review | Rulix",
    description:
      "Help universities and research teams prepare clearer classification reviews before qualified reviewers spend time on the final decision.",
    pageKind: "use-cases",
    legacyAudience: "research"
  },
  {
    key: "manufacturer-eccn-review",
    path: "/manufacturer-eccn-review",
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Help manufacturers and labs collect missing product facts and prepare a clearer ECCN review record.",
    pageKind: "use-cases",
    legacyAudience: "industry"
  }
];

export const MARKETING_SITEMAP_PAGES = MARKETING_SITE_PAGES.filter((page) => !page.canonicalPath);

export function normalizeMarketingPath(pathname: string) {
  const clean = pathname.trim() || "/";
  return clean !== "/" && clean.endsWith("/") ? clean.slice(0, -1) : clean;
}

export function marketingPageForPath(pathname: string): MarketingPageMeta {
  const normalizedPath = normalizeMarketingPath(pathname);
  return MARKETING_SITE_PAGES.find((page) => page.path === normalizedPath) ?? MARKETING_SITE_PAGES[0];
}

export function isMarketingRoute(pathname: string) {
  const normalizedPath = normalizeMarketingPath(pathname);
  return MARKETING_SITE_PAGES.some((page) => page.path === normalizedPath);
}

export function marketingCanonicalPath(page: MarketingPageMeta) {
  return page.canonicalPath ?? page.path;
}
