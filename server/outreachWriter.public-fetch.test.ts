// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutreachDraft, OutreachLead } from "../src/types";

const mocks = vi.hoisted(() => ({
  dispatchAuthorizedAiRequest: vi.fn(),
  fetchPublicHttp: vi.fn()
}));

vi.mock("./publicHttp", () => ({ fetchPublicHttp: mocks.fetchPublicHttp }));
vi.mock("./aiClient", () => ({
  outreachProviderReady: () => true,
  resolveModel: (model: string) => model
}));
vi.mock("./aiEgressGateway", () => ({
  AiEgressPolicyError: class AiEgressPolicyError extends Error {},
  dispatchAuthorizedAiRequest: mocks.dispatchAuthorizedAiRequest,
  resolveConfiguredAiLane: vi.fn()
}));

import { personalizeOutreachDraft } from "./outreachWriter";

const lead: OutreachLead = {
  leadId: "lead-1",
  organization: "Example University",
  organizationType: "research_institution",
  segment: "Research compliance",
  website: "https://public.example/",
  domain: "public.example",
  city: "Example",
  state: "VA",
  source: "Public directory",
  sourceUrl: "https://public.example/contact",
  fitScore: 90,
  priority: "A",
  email: "compliance@public.example",
  status: "verified",
  outreachAngle: "Research compliance",
  owner: "",
  notes: "",
  persona: "Export compliance"
};

const draft: OutreachDraft = {
  leadId: lead.leadId,
  organization: lead.organization,
  email: lead.email,
  subject: "A small Rulix pilot",
  body: "I am building Rulix.\n\nWould you be open to a 15-minute conversation?\n\nIf this is not relevant, I will not follow up.",
  model: "test-model",
  updatedAt: "2026-07-14T00:00:00.000Z"
};

describe("outreach public-source admission", () => {
  beforeEach(() => {
    mocks.dispatchAuthorizedAiRequest.mockReset();
    mocks.fetchPublicHttp.mockReset();
  });

  it("never invokes a model when every source fails the connection-bound check", async () => {
    mocks.fetchPublicHttp.mockRejectedValue(new Error("connected peer did not match"));

    const result = await personalizeOutreachDraft(lead, draft);

    expect(result.personalizationStatus).toBe("needs-research");
    expect(result.personalizationDetail).toMatch(/no safe public source/i);
    expect(mocks.fetchPublicHttp).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchAuthorizedAiRequest).not.toHaveBeenCalled();
  });
});
