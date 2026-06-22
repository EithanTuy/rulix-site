// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  normalizePersonalizationReview,
  validateSubtlePersonalization
} from "./outreachWriter";

describe("outreach personalization guardrails", () => {
  const original = [
      "I am building Rulix to help export-control teams review memo reasoning against official sources.",
      "I am looking for a small number of potential pilot users.",
      "Would you be open to a 15-minute conversation to see whether a small pilot is worth exploring?",
      "If this is not relevant, I will not follow up."
    ].join("\n\n");

  it("allows restrained edits while preserving structure and most original wording", () => {
    const personalized = [
      "Brown routes export-control questions through research administration. I am building Rulix to help teams review memo reasoning against official sources.",
      "I am looking for a small number of potential pilot users in research compliance.",
      "Would you be open to a 15-minute conversation to see whether a small pilot is worth exploring?",
      "If this is not relevant, I will not follow up."
    ].join("\n\n");

    expect(() => validateSubtlePersonalization(
      { subject: "A small Rulix pilot", body: original },
      "A small Rulix pilot",
      personalized
    )).not.toThrow();
    expect(personalized.split("\n\n")).toHaveLength(original.split("\n\n").length);
  });

  it.each([
    "Your impressive research program really stood out to me.",
    "Your exceptional compliance work makes Rulix a perfect fit.",
    "I was inspired by your groundbreaking and innovative research."
  ])("rejects flattering personalization: %s", (opening) => {
    const body = original.replace(
      "I am building Rulix",
      `${opening} I am building Rulix`
    );
    expect(() => validateSubtlePersonalization(
      { subject: "A small Rulix pilot", body: original },
      "A small Rulix pilot",
      body
    )).toThrow(/flattering language/i);
  });

  it("rejects structural rewrites and removed calls to action", () => {
    expect(() => validateSubtlePersonalization(
      { subject: "A small Rulix pilot", body: original },
      "A different subject",
      "Brown has an export office. Rulix may help.\n\nIf this is not relevant, I will not follow up."
    )).toThrow(/paragraph structure/i);
    expect(() => validateSubtlePersonalization(
      { subject: "A small Rulix pilot", body: original },
      "A small Rulix pilot",
      original.replace("15-minute", "brief")
    )).toThrow(/15-minute/i);
  });

  it("rejects a wholesale rewrite even when paragraph count is preserved", () => {
    const rewritten = [
      "Brown handles complex compliance matters, and Rulix provides modern support.",
      "Our advanced platform creates substantial operational value.",
      "Would you schedule a 15-minute product demonstration?",
      "If this is not relevant, I will not follow up."
    ].join("\n\n");
    expect(() => validateSubtlePersonalization(
      { subject: "A small Rulix pilot", body: original },
      "Modern compliance support",
      rewritten
    )).toThrow(/rewrote too much/i);
  });

  it("defaults malformed reviewer output to rejection", () => {
    expect(normalizePersonalizationReview({ decision: "maybe", reason: "" })).toEqual({
      decision: "reject",
      reason: "The edit was not clearly better than the default."
    });
    expect(normalizePersonalizationReview({
      decision: "approve",
      reason: "The source is relevant and the change is understated."
    })).toEqual({
      decision: "approve",
      reason: "The source is relevant and the change is understated."
    });
  });
});
