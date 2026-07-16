import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { UserProfile } from "../src/types";

const bootstrapSecret = "rulix-e2e-bootstrap";
const roles: UserProfile["role"][] = [
  "submitter",
  "reviewer",
  "counsel",
  "export-control-officer"
];

for (const role of roles) {
  test(`${role} can open the reviewer workspace and its progressive help`, async ({ page }, testInfo) => {
    const errors = collectRuntimeErrors(page);
    const session = await provisionAccount(page, role, testInfo.project.name);
    const title = `${role} responsive review`;
    await seedReview(page, session.csrfToken, title);

    await page.goto("/app");

    await expect(page).toHaveTitle("Rulix ECCN");
    await expect(page.getByText("Review Queue", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Help and getting started" }).click();
    await expect(page.getByRole("heading", { name: "From memo to defensible decision" })).toBeVisible();
    await page.getByRole("button", { name: "Close Rulix guide" }).click();
    await expect(page.getByRole("heading", { name: "From memo to defensible decision" })).toBeHidden();

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "critical")).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("an officer can move between dashboard operations surfaces", async ({ page }, testInfo) => {
  const errors = collectRuntimeErrors(page);
  await provisionAccount(page, "export-control-officer", `dashboard-${testInfo.project.name}`);

  await page.goto("/dashboard");

  await expect(page).toHaveTitle("Rulix Dash");
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await page.getByRole("button", { name: "Usage" }).click();
  await expect(page.getByRole("heading", { name: "AI usage and spend" })).toBeVisible();
  await expect(page).toHaveURL(/#usage$/);
  await page.getByRole("button", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Account activity" })).toBeVisible();
  await expect(page).toHaveURL(/#accounts$/);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical")).toEqual([]);
  expect(errors).toEqual([]);
});

async function provisionAccount(page: Page, role: UserProfile["role"], suffix: string) {
  const email = `${role}.${suffix}.${Date.now()}.${Math.random().toString(16).slice(2)}@e2e.rulix.local`;
  const inviteResponse = await page.request.post("/api/auth/bootstrap-invite", {
    headers: { "x-rulix-bootstrap-secret": bootstrapSecret },
    data: { email, name: `${role} E2E`, role }
  });
  expect(inviteResponse.ok()).toBe(true);
  const invite = await inviteResponse.json() as { inviteLink: string };
  const token = new URLSearchParams(new URL(invite.inviteLink).hash.replace(/^#/, "")).get("invite");
  expect(token).toBeTruthy();

  const acceptedResponse = await page.request.post("/api/auth/invite/accept", {
    data: { token, password: "Correct-Horse-2026" }
  });
  expect(acceptedResponse.ok()).toBe(true);
  return acceptedResponse.json() as Promise<{ csrfToken: string; user: UserProfile }>;
}

async function seedReview(page: Page, csrfToken: string, title: string) {
  const response = await page.request.post("/api/reviews", {
    headers: { "x-rulix-csrf": csrfToken },
    data: {
      requestId: crypto.randomUUID(),
      title,
      itemFamily: "Cryogenic controller",
      manufacturer: "Rulix Test Instruments",
      intendedUse: "University research laboratory",
      dataClass: "proprietary",
      sourcePath: "self-classification",
      memoText: `# ${title}\n\n## Item\nCryogenic laboratory controller.\n\n## Review\nConfirm technical thresholds before classification.`,
      attachments: []
    }
  });
  expect(response.ok()).toBe(true);
}

function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === "http://127.0.0.1:8789") {
      errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    }
  });
  return errors;
}
