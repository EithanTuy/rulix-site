// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import { sha256Canonical } from "./domain/hashes";
import {
  DEFAULT_BEDROCK_MODEL,
  buildCouncilProviderRequest,
  buildMemoBuilderProviderRequest,
  buildMemoChatProviderRequest,
  councilApprovalPayload,
  memoBuilderApprovalPayload,
  memoChatApprovalPayload
} from "./bedrockCouncil";
import {
  buildDocumentProviderRequest,
  documentExtractionApprovalPayload,
  documentProviderPasses,
  prepareDocumentExtractionInput
} from "./documentExtraction";
import type { AiProviderLane } from "./aiEgressGateway";

describe("AI approval canonical payloads", () => {
  it("builds a byte-stable council request for the same immutable memo revision", () => {
    const memo = reviewFixtures[0];
    const first = buildCouncilProviderRequest(memo, "standard", DEFAULT_BEDROCK_MODEL).body;

    vi.setSystemTime(new Date("2040-01-02T03:04:05.000Z"));
    const later = buildCouncilProviderRequest(memo, "standard", DEFAULT_BEDROCK_MODEL).body;
    vi.useRealTimers();

    expect(later).toEqual(first);
    expect(sha256Canonical(later)).toBe(sha256Canonical(first));
    expect(sha256Canonical(councilApprovalPayload(memo, "standard"))).toHaveLength(64);
  });

  it("binds memo chat history, pending text, and provider body without clock input", () => {
    const memo = reviewFixtures[0];
    const history = [{
      id: "chat-previous",
      memoId: memo.id,
      role: "user" as const,
      text: "What evidence is missing?",
      createdAt: "2026-01-01T00:00:00.000Z",
      memoRevision: memo.revision,
      memoVersion: memo.version,
      memoHash: memo.contentHash
    }];
    const message = "Explain the current recommendation.";
    const first = buildMemoChatProviderRequest(memo, message, history, DEFAULT_BEDROCK_MODEL);
    const second = buildMemoChatProviderRequest(memo, message, history, DEFAULT_BEDROCK_MODEL);

    expect(sha256Canonical(first)).toBe(sha256Canonical(second));
    expect(sha256Canonical(memoChatApprovalPayload(memo, message, history))).toHaveLength(64);
    expect(sha256Canonical(buildMemoChatProviderRequest(memo, `${message} changed`, history, DEFAULT_BEDROCK_MODEL)))
      .not.toBe(sha256Canonical(first));
  });

  it("binds the exact persisted builder history and pending message", () => {
    const messages = [
      { role: "user" as const, content: "Draft a memo for a 1550 nm laser." },
      { role: "assistant" as const, content: "What is the output power?" },
      { role: "user" as const, content: "20 mW continuous wave." }
    ];
    const first = buildMemoBuilderProviderRequest(messages, "claude-sonnet-4-6");
    const second = buildMemoBuilderProviderRequest(messages, "claude-sonnet-4-6");

    expect(sha256Canonical(first)).toBe(sha256Canonical(second));
    expect(sha256Canonical(memoBuilderApprovalPayload(messages))).toHaveLength(64);
    expect(sha256Canonical(buildMemoBuilderProviderRequest(
      [...messages.slice(0, -1), { role: "user", content: "21 mW continuous wave." }],
      "claude-sonnet-4-6"
    ))).not.toBe(sha256Canonical(first));
  });

  it("normalizes equivalent PDF base64 forms and authorizes exactly two distinct provider passes", () => {
    const bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii");
    const raw = prepareDocumentExtractionInput({
      fileName: "exact-spec.pdf",
      mediaType: "application/pdf",
      dataBase64: bytes.toString("base64")
    });
    const dataUrl = prepareDocumentExtractionInput({
      fileName: "exact-spec.pdf",
      mediaType: "application/pdf",
      dataBase64: `data:application/pdf;base64,${bytes.toString("base64")}`
    });
    expect(raw.tooLarge).toBe(false);
    expect(dataUrl.tooLarge).toBe(false);
    if (raw.tooLarge || dataUrl.tooLarge) throw new Error("fixture unexpectedly exceeded the limit");

    expect(dataUrl.input).toEqual(raw.input);
    expect(documentExtractionApprovalPayload(raw.input)).toEqual({
      document: {
        fileName: "exact-spec.pdf",
        mediaType: "application/pdf",
        byteLength: bytes.byteLength,
        bytesSha256: createHash("sha256").update(bytes).digest("hex")
      }
    });
    expect(JSON.stringify(documentExtractionApprovalPayload(raw.input))).not.toContain(bytes.toString("base64"));

    const lane: AiProviderLane = {
      provider: "amazon-bedrock",
      region: "us-east-1",
      model: DEFAULT_BEDROCK_MODEL
    };
    expect(documentProviderPasses(raw.input)).toEqual(["primary", "pdf-image-fallback"]);
    const primary = buildDocumentProviderRequest(raw.input, lane, "primary");
    const fallback = buildDocumentProviderRequest(raw.input, lane, "pdf-image-fallback");
    expect(sha256Canonical(primary)).not.toBe(sha256Canonical(fallback));
  });
});
