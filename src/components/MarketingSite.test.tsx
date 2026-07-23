import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MarketingSite,
  isMarketingPath,
  marketingMetaForPath,
  nextMarketingHeaderVisibility
} from "./MarketingSite";
import { marketingCanonicalPath } from "../marketingPages";

const primaryPages = [
  ["/", "AI-assisted export classification."],
  ["/product", "Review classification work without losing the reasoning."],
  ["/use-cases", "Built for teams that have to explain the classification."],
  ["/trust", "A person makes the final decision."],
  ["/contact", "Talk with us about your classification workflow."]
] as const;

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

function renderPath(path: string) {
  window.history.replaceState({}, "", path);
  return render(<MarketingSite />);
}

describe("marketing pages", () => {
  it.each(primaryPages)("renders %s as a concise standalone page", (path, heading) => {
    const { container } = renderPath(path);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
    expect(container.querySelectorAll(".rulix-primary-action")).toHaveLength(1);
    expect(container.querySelector("form")).not.toBeInTheDocument();
    expect(container.querySelector("video")).not.toBeInTheDocument();
    expect(container.querySelector('[role="tablist"]')).not.toBeInTheDocument();
    expect(container.querySelector(".faq-item, .trust-item, details")).not.toBeInTheDocument();
  });

  it("exposes the approved email as the contact action", () => {
    renderPath("/contact");

    const contact = screen.getByRole("link", { name: /email rulix/i });
    expect(contact).toHaveTextContent("tuyilin2@msu.edu");
    expect(contact).toHaveAttribute("href", "mailto:tuyilin2@msu.edu?subject=Rulix%20inquiry");
  });

  it("uses real page paths in the shared header", () => {
    renderPath("/");

    expect(screen.getByRole("link", { name: "Product" })).toHaveAttribute("href", "/product");
    expect(screen.getByRole("link", { name: "Use Cases" })).toHaveAttribute("href", "/use-cases");
    expect(screen.getByRole("link", { name: "Trust" })).toHaveAttribute("href", "/trust");
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/contact");
  });

  it("keeps legacy routes functional and preserves their metadata", () => {
    const legacyPaths = [
      "/export-control-memo-review",
      "/eccn-classification-assistant",
      "/ai-export-compliance-review",
      "/university-export-control-review",
      "/manufacturer-eccn-review"
    ];

    for (const path of legacyPaths) {
      expect(isMarketingPath(path)).toBe(true);
      const page = marketingMetaForPath(path);
      expect(page.path).toBe(path);
      expect(page.title).toContain("Rulix");
      expect(marketingCanonicalPath(page)).toBe(path);
    }
  });

  it("maps site and security aliases to primary canonical pages", () => {
    expect(marketingMetaForPath("/site").pageKind).toBe("home");
    expect(marketingCanonicalPath(marketingMetaForPath("/site"))).toBe("/");
    expect(marketingMetaForPath("/security").pageKind).toBe("trust");
    expect(marketingCanonicalPath(marketingMetaForPath("/security"))).toBe("/trust");
  });

  it("applies page title, description, and canonical metadata", () => {
    renderPath("/product");

    expect(document.title).toBe("How Rulix works | AI-assisted export classification");
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      marketingMetaForPath("/product").description
    );
    expect(document.querySelector('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "http://localhost:3000/product"
    );
  });
});

describe("marketing header visibility", () => {
  const base = {
    previousY: 200,
    currentY: 200,
    currentlyVisible: true,
    mobileNavOpen: false,
    hasFocus: false
  };

  it("stays visible at the top", () => {
    expect(nextMarketingHeaderVisibility({ ...base, currentY: 12 })).toBe(true);
  });

  it("hides after meaningful downward movement", () => {
    expect(nextMarketingHeaderVisibility({ ...base, currentY: 212 })).toBe(false);
  });

  it("reappears immediately when the user scrolls up mid-page", () => {
    expect(
      nextMarketingHeaderVisibility({
        ...base,
        previousY: 900,
        currentY: 897,
        currentlyVisible: false
      })
    ).toBe(true);
  });

  it("is forced visible for the mobile menu and keyboard focus", () => {
    expect(
      nextMarketingHeaderVisibility({ ...base, currentY: 500, currentlyVisible: false, mobileNavOpen: true })
    ).toBe(true);
    expect(
      nextMarketingHeaderVisibility({ ...base, currentY: 500, currentlyVisible: false, hasFocus: true })
    ).toBe(true);
  });
});
