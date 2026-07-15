// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { OutreachLead } from "../src/types";
import { LocalAccountStore, emptyAccountState } from "./store";

describe("account state identity merges", () => {
  it("deduplicates discovered leads by leadId while preferring the incoming record", async () => {
    const store = new LocalAccountStore({ persist: false });
    const original = lead("lead-1", "Original Organization");
    await store.replaceAccountState("account-1", {
      ...emptyAccountState(),
      discoveredLeads: [original]
    });

    const updated = { ...original, organization: "Updated Organization", fitScore: 95 };
    const second = lead("lead-2", "Second Organization");
    await store.replaceAccountState("account-1", {
      ...emptyAccountState(),
      discoveredLeads: [updated, second]
    });

    const restored = await store.getAccountState("account-1");
    expect(restored.discoveredLeads).toEqual([updated, second]);
  });
});

function lead(leadId: string, organization: string): OutreachLead {
  return {
    leadId,
    organization,
    organizationType: "manufacturer",
    segment: "industrial",
    website: "https://example.com",
    domain: "example.com",
    city: "Boston",
    state: "MA",
    source: "test",
    sourceUrl: "https://example.com/source",
    fitScore: 80,
    priority: "B",
    email: "export@example.com",
    status: "new",
    outreachAngle: "Export classification workflow",
    owner: "",
    notes: "",
    persona: "export-control"
  };
}
