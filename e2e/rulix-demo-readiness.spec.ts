import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { UserProfile } from "../src/types";

const bootstrapSecret = "rulix-e2e-bootstrap";
const demoTitle = "SYNTHETIC DEMO - RLX-200 Cryogenic Controller";
const demoMemo = `# ${demoTitle}

## Synthetic sample scope
This fictional public sample describes a laboratory cryogenic controller used for university research.

## Technical characteristics
- Base temperature: 1.2 K
- Cooling capacity: 20 mW at 1.2 K
- Dimensions: 120 x 80 x 40 mm
- Mass: 2.1 kg
- Intended use: public, non-military laboratory evaluation

## Reviewer question
Verify the relevant Category 3 threshold and approved source before relying on a classification.`;

test("the workbench fits common demo laptop widths without clipping", async ({ page }, testInfo) => {
  const runtime = collectRuntimeErrors(page);
  const session = await provisionAccount(page, "export-control-officer", `layout-${testInfo.project.name}`);
  const reviewId = await seedReview(page, session.csrfToken, `${testInfo.project.name} layout review`);

  await page.goto(`/app#/reviews/${reviewId}/overview`);
  await expect(page.getByRole("heading", { name: `${testInfo.project.name} layout review`, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review the current revision" })).toBeVisible();
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await expect(page.getByText(/Public\/sample · revision 1/)).toBeVisible();

  const layout = await page.evaluate(() => {
    const selectors = [
      ".px-app-content",
      ".review-workbench",
      ".review-stages",
      ".review-layout",
      ".review-focus",
      ".review-context"
    ];
    const overflow = selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return {
        selector,
        clientWidth: element?.clientWidth ?? 0,
        scrollWidth: element?.scrollWidth ?? 0
      };
    });
    const grid = document.querySelector<HTMLElement>(".review-layout");
    const gridRect = grid?.getBoundingClientRect();
    const clippedChildren = grid && gridRect
      ? [...grid.children].filter((child) => {
          const rect = child.getBoundingClientRect();
          return rect.left < gridRect.left - 1 || rect.right > gridRect.right + 1;
        }).length
      : -1;
    return {
      overflow,
      clippedChildren,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0
    };
  });

  for (const measurement of layout.overflow) {
    expect(measurement.scrollWidth, `${measurement.selector} should not scroll horizontally`).toBeLessThanOrEqual(measurement.clientWidth + 1);
  }
  expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth + 1);
  expect(layout.clippedChildren).toBe(0);
  expect(layout.gridColumns).toBe(2);

  await assertPageHealth(page, runtime);
});

test("an officer completes the reviewer golden path and downloads a complete report", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo-1280", "The full journey runs once at the primary demo viewport.");
  const runtime = collectRuntimeErrors(page);
  const session = await provisionAccount(page, "export-control-officer", "golden-path");

  await page.goto("/app#/home");
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/#\/work$/);
  await page.locator("button.work-start").click();

  const modal = page.getByRole("dialog", { name: "Start review" });
  await expect(modal).toBeVisible();
  await modal.getByLabel("Review title").fill(demoTitle);
  await modal.getByLabel("Memo content").fill(demoMemo);
  await modal.getByText("Review details", { exact: true }).click();
  await modal.getByLabel("Manufacturer or source").fill("Rulix Synthetic Instruments");
  await modal.getByLabel("Data class").selectOption("public");
  await expect(modal.getByLabel("Data class")).toHaveValue("public");

  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/reviews"
  );
  await modal.getByRole("button", { name: "Create review" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json() as { review: { id: string; dataClass?: string } };
  expect(created.review.dataClass).toBe("public");

  await expect(page.getByRole("heading", { name: demoTitle, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /Data and provenance Public\/sample/ })).toBeVisible();
  await page.getByRole("button", { name: "Continue to Review" }).click();
  await page.getByRole("button", { name: "Approve & run AI review" }).click();

  await expect(page.getByRole("heading", { name: "3A001.a.5" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Verify the controlled cryogenic threshold" })).toBeVisible();
  await expect(page.getByText("Exact-content approval", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Continue to Decide & Export" }).click();
  const rationale = "Accepted for the synthetic demo after verifying the cited threshold and evidence trail.";
  await page.getByPlaceholder("Explain the evidence, judgment, and any conditions for this decision.").fill(rationale);
  await page.getByRole("button", { name: "Accept & sign" }).click();
  await expect(page.getByText("Accept recorded", { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export signed result" }).first().click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const report = await readFile(downloadPath!, "utf8");
  expect(report.length).toBeGreaterThan(1_000);
  expect(report).toContain(demoTitle);
  expect(report).toContain("## AI Review Scope");
  expect(report).toContain("Data class: public");
  expect(report).toContain("Verify the controlled cryogenic threshold");
  expect(report).toContain("Action: accept");
  expect(report).toContain(rationale);
  expect(report).toContain(`Signed By: ${session.user.name}`);
  expect(report).toContain("## Audit Trail");
  expect(report).toContain("Review created");

  await page.getByRole("button", { name: "View audit history" }).click();
  await expect(page.getByRole("complementary", { name: "Review context" })).toBeVisible();
  await expect(page.getByText("Reviewer decision: accept", { exact: true })).toBeVisible();

  await assertPageHealth(page, runtime);
});

test("marketing demos pause offscreen and the access form persists a request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo-1280", "The timed marketing interaction runs once.");
  const runtime = collectRuntimeErrors(page);
  await page.goto("/");

  await expect(page).toHaveTitle(/Rulix/);
  await expect(page.getByRole("heading", { name: /Find the weak link/ })).toBeVisible();
  const activeDemo = page.locator(".demo-tabs button.is-active");
  await expect(activeDemo).toHaveText("Find unsupported reasoning");
  await page.waitForTimeout(6_300);
  await expect(activeDemo).toHaveText("Find unsupported reasoning");

  await page.locator("#product").scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "Resolve with evidence" }).click();
  await expect(page.getByText("Turn a gap into the next reviewer action.")).toBeVisible();

  await page.getByRole("link", { name: "Request access" }).first().click();
  await page.getByLabel("Work email").fill(`demo-readiness-${Date.now()}@e2e.rulix.local`);
  await page.getByLabel("Organization").fill("Rulix synthetic demo QA");
  await page.getByLabel("Role").fill("Export control officer");
  await page.getByLabel("What would you like to review?").fill("A fictional public cryogenic controller memo.");
  const accessResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/access-requests"
  );
  await page.locator("form.access-form").getByRole("button", { name: "Request access" }).click();
  const accessResponse = await accessResponsePromise;
  expect(accessResponse.status()).toBe(201);
  await expect(page.getByText("Request received.")).toBeVisible();

  await assertPageHealth(page, runtime);
});

test("marketing mobile navigation and reduced-motion media stay usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo-1366", "The mobile override runs once.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtime = collectRuntimeErrors(page);
  await page.goto("/");

  await expect(page.locator(".rulix-hero__media video")).toHaveCount(0);
  await expect(page.locator(".rulix-hero__media > img")).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  const initialDemo = await page.locator(".demo-tabs button.is-active").textContent();
  await page.waitForTimeout(6_300);
  await expect(page.locator(".demo-tabs button.is-active")).toHaveText(initialDemo ?? "Find unsupported reasoning");
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  await assertPageHealth(page, runtime);
});

async function provisionAccount(page: Page, role: UserProfile["role"], suffix: string) {
  const email = `${role}.${suffix}.${Date.now()}.${Math.random().toString(16).slice(2)}@e2e.rulix.local`;
  const inviteResponse = await page.request.post("/api/auth/bootstrap-invite", {
    headers: { "x-rulix-bootstrap-secret": bootstrapSecret },
    data: { email, name: "Demo Officer", role }
  });
  expect(inviteResponse.status()).toBe(201);
  const invite = await inviteResponse.json() as { inviteLink: string };
  const token = new URLSearchParams(new URL(invite.inviteLink).hash.replace(/^#/, "")).get("invite");
  expect(token).toBeTruthy();

  const acceptedResponse = await page.request.post("/api/auth/invite/accept", {
    data: { token, password: "Correct-Horse-2026" }
  });
  expect(acceptedResponse.status()).toBe(201);
  return acceptedResponse.json() as Promise<{ csrfToken: string; user: UserProfile }>;
}

async function seedReview(page: Page, csrfToken: string, title: string) {
  const response = await page.request.post("/api/reviews", {
    headers: { "x-rulix-csrf": csrfToken },
    data: {
      requestId: crypto.randomUUID(),
      title,
      itemFamily: "Synthetic cryogenic controller",
      manufacturer: "Rulix Synthetic Instruments",
      intendedUse: "Public university laboratory sample",
      dataClass: "public",
      sourcePath: "self-classification",
      memoText: demoMemo.replace(demoTitle, title),
      attachments: []
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as { review: { id: string; dataClass?: string } };
  expect(body.review.dataClass).toBe("public");
  return body.review.id;
}

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === "http://127.0.0.1:8789") {
      errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin === "http://127.0.0.1:8789" && response.status() >= 400) {
      errors.push(`${response.request().method()} ${response.url()} HTTP ${response.status()}`);
    }
  });
  return errors;
}

async function assertPageHealth(page: Page, runtimeErrors: string[]) {
  const overlay = page.locator("vite-error-overlay, #webpack-dev-server-client-overlay, [data-nextjs-dialog-overlay]");
  expect(await overlay.count()).toBe(0);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  const highImpact = accessibility.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" "))
    }));
  expect(highImpact).toEqual([]);
  expect(runtimeErrors).toEqual([]);
}
