import cors from "cors";
import express from "express";
import { officialCorpus } from "../src/data/corpus";
import { sampleMemos } from "../src/data/sampleMemos";
import { analyzeMemo } from "../src/lib/eccnReview";
import { createAuditEvent, deriveReviewStatus, seedAuditEvents } from "../src/lib/reviewLifecycle";
import type { AuditEvent, MemoRecord, NewReviewInput, ReviewerDecision } from "../src/types";
import { getAnthropicRuntime, runCouncilAnalysis } from "./anthropicCouncil";

interface Store {
  memos: Map<string, MemoRecord>;
  decisions: Map<string, ReviewerDecision>;
  auditEvents: AuditEvent[];
}

const DEFAULT_STORE: Store = {
  memos: new Map(sampleMemos.map((memo) => [memo.id, memo])),
  decisions: new Map(),
  auditEvents: seedAuditEvents(sampleMemos)
};

export function createApp(store: Store = cloneStore(DEFAULT_STORE)) {
  const app = express();

  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/health", (_req, res) => {
    const provider = getAnthropicRuntime();
    res.json({
      ok: true,
      service: "rulix-eccn-api",
      phase: "phase-2-mvp",
      time: new Date().toISOString(),
      provider
    });
  });

  app.get("/api/corpus", (_req, res) => {
    res.json(officialCorpus);
  });

  app.get("/api/reviews", (_req, res) => {
    res.json({
      reviews: Array.from(store.memos.values()),
      auditEvents: store.auditEvents
    });
  });

  app.post("/api/reviews", (req, res) => {
    const memo = createMemoRecord(req.body as Partial<NewReviewInput>);
    const result = analyzeMemo(memo);
    const storedMemo = {
      ...memo,
      status: deriveReviewStatus(result)
    };
    store.memos.set(storedMemo.id, storedMemo);
    store.auditEvents.unshift(
      createAuditEvent(
        storedMemo.id,
        "Review created",
        "Review was created through the Phase 2 backend API.",
        storedMemo.dataClass === "itar-risk" || storedMemo.dataClass === "cui" ? "escalate" : "info"
      )
    );
    res.status(201).json({ review: storedMemo, result });
  });

  app.get("/api/reviews/:id", (req, res) => {
    const memo = store.memos.get(req.params.id);
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    res.json({
      review: memo,
      decision: store.decisions.get(memo.id),
      auditEvents: store.auditEvents.filter((event) => event.memoId === memo.id)
    });
  });

  app.post("/api/reviews/:id/analyze", async (req, res) => {
    const memo = store.memos.get(req.params.id);
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const result = await runCouncilAnalysis(memo);
    store.memos.set(memo.id, {
      ...memo,
      status: deriveReviewStatus(result, store.decisions.get(memo.id))
    });
    res.json({ result });
  });

  app.post("/api/ai/review", async (req, res) => {
    const memo = coerceMemo(req.body?.memo ?? req.body);
    if (!memo) {
      res.status(400).json({ error: "Request body must include a memo with memoText." });
      return;
    }

    const result = await runCouncilAnalysis(memo);
    res.json({ result });
  });

  app.post("/api/reviews/:id/decision", (req, res) => {
    const memo = store.memos.get(req.params.id);
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const decision = coerceDecision(req.body);
    if (!decision) {
      res.status(400).json({ error: "Decision requires action and notes." });
      return;
    }

    store.decisions.set(memo.id, decision);
    const result = analyzeMemo(memo);
    const updatedMemo = {
      ...memo,
      status: deriveReviewStatus(result, decision)
    };
    store.memos.set(memo.id, updatedMemo);
    store.auditEvents.unshift(
      createAuditEvent(
        memo.id,
        `Reviewer decision: ${decision.action}`,
        decision.notes,
        decision.action === "override" ? "escalate" : decision.action === "request-info" ? "review" : "info"
      )
    );

    res.json({ review: updatedMemo, decision });
  });

  return app;
}

function cloneStore(store: Store): Store {
  return {
    memos: new Map(store.memos),
    decisions: new Map(store.decisions),
    auditEvents: [...store.auditEvents]
  };
}

function createMemoRecord(input: Partial<NewReviewInput>): MemoRecord {
  const now = new Date().toISOString().slice(0, 10);
  return {
    id: `review-${Date.now()}`,
    title: normalizeText(input.title, "New ECCN Classification Memo"),
    itemFamily: normalizeText(input.itemFamily, "Research equipment"),
    owner: "API User",
    updatedAt: now,
    documentCode: `API-${now.replaceAll("-", "")}`,
    status: "draft",
    memoText: normalizeText(input.memoText, ""),
    attachments: Array.isArray(input.attachments) ? input.attachments.filter(isString) : [],
    dataClass: input.dataClass ?? "proprietary",
    sourcePath: input.sourcePath ?? "self-classification",
    manufacturer: normalizeOptional(input.manufacturer),
    intendedUse: normalizeOptional(input.intendedUse)
  };
}

function coerceMemo(value: unknown): MemoRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<MemoRecord>;
  if (!input.memoText?.trim()) return undefined;
  const now = new Date().toISOString().slice(0, 10);

  return {
    id: normalizeText(input.id, `adhoc-${Date.now()}`),
    title: normalizeText(input.title, "Ad hoc ECCN Memo"),
    itemFamily: normalizeText(input.itemFamily, "Research equipment"),
    owner: normalizeText(input.owner, "API User"),
    updatedAt: normalizeText(input.updatedAt, now),
    documentCode: normalizeText(input.documentCode, `ADHOC-${now.replaceAll("-", "")}`),
    status: input.status ?? "draft",
    memoText: input.memoText,
    attachments: Array.isArray(input.attachments) ? input.attachments.filter(isString) : [],
    dataClass: input.dataClass ?? "proprietary",
    sourcePath: input.sourcePath ?? "self-classification",
    manufacturer: normalizeOptional(input.manufacturer),
    intendedUse: normalizeOptional(input.intendedUse)
  };
}

function coerceDecision(value: unknown): ReviewerDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<ReviewerDecision>;
  if (
    input.action !== "accept" &&
    input.action !== "request-info" &&
    input.action !== "override"
  ) {
    return undefined;
  }
  if (!input.notes?.trim()) return undefined;

  return {
    action: input.action,
    notes: input.notes.trim(),
    signedBy: input.action === "accept" ? input.signedBy ?? "API Reviewer" : input.signedBy,
    signedAt: input.action === "accept" ? input.signedAt ?? new Date().toISOString() : input.signedAt
  };
}

function normalizeText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeOptional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
