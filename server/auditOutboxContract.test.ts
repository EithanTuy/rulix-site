// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/types";
import {
  AuditOutboxContractError,
  canonicalAuditPayload,
  canonicalizeAuthoritativeAuditEvent
} from "./auditOutboxContract";
import { sha256Canonical } from "./domain/hashes";

const accountId = "workspace-user-7";
const event: AuditEvent = {
  id: "audit-7",
  memoId: "memo-7",
  at: "2026-07-14T04:05:06.789Z",
  actor: "Jane Reviewer",
  actorId: "user-7",
  organizationId: "org-7",
  action: "Reviewer decision: accept",
  detail: "Accepted after reviewing the bound analysis.",
  severity: "info",
  metadata: {
    subjectId: "memo-7",
    subjectType: "review",
    outcome: "succeeded",
    source: "authenticated-api",
    actorType: "user",
    decisionId: "decision-7",
    optionalUndefined: undefined
  }
};

describe("shared audit outbox contract", () => {
  it("produces the exact canonical payload and hash used by producer and consumer", () => {
    const canonical = canonicalAuditPayload(accountId, event);

    expect(canonical.accountId).toBe(accountId);
    expect(canonical.auditEvent).toMatchObject({
      actorId: "user-7",
      organizationId: "org-7",
      metadata: {
        actorType: "user",
        source: "authenticated-api",
        outcome: "succeeded",
        subjectType: "review",
        subjectId: "memo-7"
      }
    });
    expect(canonical.auditEvent.metadata).not.toHaveProperty("optionalUndefined");
    expect(canonical.payloadHash).toBe(sha256Canonical({
      accountId,
      auditEvent: canonical.auditEvent
    }));
  });

  it("canonicalizes metadata insertion order without hash drift", () => {
    const reverseMetadata = Object.fromEntries(
      Object.entries(event.metadata ?? {}).reverse()
    );
    const left = canonicalAuditPayload(accountId, event);
    const right = canonicalAuditPayload(accountId, { ...event, metadata: reverseMetadata });

    expect(right.auditEvent).toEqual(left.auditEvent);
    expect(right.payloadHash).toBe(left.payloadHash);
  });

  it.each([
    ["actor whitespace", { ...event, actor: " Jane Reviewer" }],
    ["action whitespace", { ...event, action: "Reviewer decision: accept " }],
    ["metadata whitespace", {
      ...event,
      metadata: { ...event.metadata, decisionId: " decision-7" }
    }],
    ["noncanonical timestamp", { ...event, at: "2026-07-14T04:05:06Z" }]
  ])("rejects %s identically before persistence or consumption", (_label, candidate) => {
    expect(() => canonicalAuditPayload(accountId, candidate))
      .toThrow(AuditOutboxContractError);
  });

  it.each([
    ["missing actor identity", { ...event, actorId: undefined }],
    ["missing organization", { ...event, organizationId: undefined }],
    ["display name in actorId", { ...event, actorId: "Jane Reviewer" }],
    ["reserved writer metadata", {
      ...event,
      metadata: { ...event.metadata, writerId: "caller-writer" }
    }],
    ["API source with service actor", {
      ...event,
      metadata: { ...event.metadata, actorType: "service" }
    }],
    ["worker source with user actor", {
      ...event,
      metadata: { ...event.metadata, source: "analysis-worker" }
    }]
  ])("rejects %s", (_label, candidate) => {
    expect(() => canonicalAuditPayload(accountId, candidate))
      .toThrow(AuditOutboxContractError);
  });

  it("can validate an authoritative event before the account binding is known", () => {
    expect(canonicalizeAuthoritativeAuditEvent(event)).toEqual(
      canonicalAuditPayload(accountId, event).auditEvent
    );
  });
});
