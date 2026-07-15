import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdown } from "./markdown";

describe("markdown rendering security", () => {
  it("escapes untrusted HTML before applying the supported inline formatting", () => {
    const rendered = renderInline(
      '**<img src=x onerror="alert(1)">** <svg><script>alert(2)</script></svg> `</code><iframe srcdoc=x>`'
    );

    expect(rendered).toContain("<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong>");
    expect(rendered).toContain("&lt;svg&gt;&lt;script&gt;alert(2)&lt;/script&gt;&lt;/svg&gt;");
    expect(rendered).toContain("<code>&lt;/code&gt;&lt;iframe srcdoc=x&gt;</code>");
    const root = document.createElement("div");
    root.innerHTML = rendered;
    expect(root.querySelector("img, svg, script, iframe, [onerror]")).toBeNull();
  });

  it("does not create links, active attributes, or raw elements from AI markdown", () => {
    const rendered = renderMarkdown([
      "# <script>alert(1)</script>",
      "",
      "- [click](javascript:alert(1))",
      "- <a href=javascript:alert(2)>click</a>",
      "",
      "> <details open ontoggle=alert(3)>x</details>"
    ].join("\n"));

    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered).toContain("[click](javascript:alert(1))");
    expect(rendered).toContain("&lt;a href=javascript:alert(2)&gt;click&lt;/a&gt;");
    expect(rendered).toContain("&lt;details open ontoggle=alert(3)&gt;x&lt;/details&gt;");
    const root = document.createElement("div");
    root.innerHTML = rendered;
    expect(root.querySelector("script, a, details, [href], [ontoggle]")).toBeNull();
  });
});
