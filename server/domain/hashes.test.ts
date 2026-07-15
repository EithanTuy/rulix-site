// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AuditEvent, MemoRecord, ReviewResult } from "../../src/types";
import {
  canonicalJson,
  hashAuditEvent,
  hashMemoContent,
  hashReviewResult,
  sha256Canonical
} from "./hashes";

describe("domain integrity hashes", () => {
  it("hashes equivalent objects identically regardless of key insertion order", () => {
    expect(sha256Canonical({ b: 2, nested: { z: true, a: "first" }, a: 1 })).toBe(
      sha256Canonical({ a: 1, nested: { a: "first", z: true }, b: 2 })
    );
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("rejects ambiguous unsupported and cyclic values", () => {
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalJson(undefined)).toThrow("JSON value at the root");
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow("plain objects");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");
  });

  it("preserves prototype-shaped own keys without canonical hash collisions", () => {
    const ownProto = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const nestedProto = JSON.parse('{"nested":{"__proto__":"bound"}}') as Record<string, unknown>;
    expect(canonicalJson(ownProto)).toBe('{"__proto__":{"polluted":true}}');
    expect(canonicalJson(nestedProto)).toBe('{"nested":{"__proto__":"bound"}}');
    expect(sha256Canonical(ownProto)).not.toBe(sha256Canonical({}));
    expect(sha256Canonical(nestedProto)).not.toBe(sha256Canonical({ nested: {} }));
    expect(sha256Canonical({ constructor: "a" })).not.toBe(sha256Canonical({ constructor: "b" }));
    expect(sha256Canonical({ prototype: true })).not.toBe(sha256Canonical({ prototype: false }));
  });

  it("changes the memo content hash for reviewable content but not volatile record fields", () => {
    const memo = memoFixture();
    const sameContentWithDifferentRecordState: MemoRecord = {
      ...memo,
      owner: "Another reviewer",
      status: "ready"
    };
    expect(hashMemoContent(memo)).toHaveLength(64);
    expect(hashMemoContent(sameContentWithDifferentRecordState)).toBe(
      hashMemoContent(memo)
    );
    expect(hashMemoContent({ ...memo, memoText: `${memo.memoText}\nChanged.` })).not.toBe(
      hashMemoContent(memo)
    );
  });

  it("excludes stored self-digests while binding result and event content", () => {
    const result = { memoId: "memo-1", generatedAt: "2026-07-13T12:00:00.000Z" } as ReviewResult;
    const withDigest = { ...result, resultHash: "old" } as ReviewResult;
    expect(hashReviewResult(withDigest)).toBe(hashReviewResult(result));
    expect(hashReviewResult({ ...result, generatedAt: "2026-07-13T12:01:00.000Z" } as ReviewResult))
      .not.toBe(hashReviewResult(result));

    const event = auditFixture();
    expect(hashAuditEvent({ ...event, eventHash: "old" } as AuditEvent)).toBe(hashAuditEvent(event));
    expect(hashAuditEvent({ ...event, actor: "Different actor" })).not.toBe(hashAuditEvent(event));
  });
});

function memoFixture(): MemoRecord {
  return {
    id: "memo-1",
    title: "Signal analyzer review",
    itemFamily: "RF test equipment",
    owner: "Reviewer",
    updatedAt: "2026-07-13",
    documentCode: "REV-1",
    status: "draft",
    memoText: "Frequency range: 44 GHz.",
    attachments: ["s3://evidence/spec.pdf#sha256=abc"],
    dataClass: "proprietary",
    sourcePath: "self-classification",
    manufacturer: "Example",
    intendedUse: "Laboratory testing"
  };
}

function auditFixture(): AuditEvent {
  return {
    id: "audit-1",
    memoId: "memo-1",
    at: "2026-07-13T12:00:00.000Z",
    actor: "Reviewer",
    action: "Revision created",
    detail: "Created revision 2.",
    severity: "info",
    previousHash: "0".repeat(64)
  } as AuditEvent;
}
