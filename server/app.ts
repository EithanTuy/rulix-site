import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { officialCorpus } from "../src/data/corpus";
import { analyzeMemo } from "../src/lib/eccnReview";
import { createAuditEvent, deriveReviewStatus } from "../src/lib/reviewLifecycle";
import type {
  AccountReviewState,
  AuditEvent,
  MemoChatMessage,
  MemoRecord,
  NewReviewInput,
  ReviewerDecision
} from "../src/types";
import {
  getAnthropicRuntime,
  runCouncilAnalysis,
  type CouncilDepth
} from "./anthropicCouncil";
import {
  StoreError,
  createAccountStore,
  type AccountStore,
  type AuthSession,
  type SessionRecord
} from "./store";

const ALLOWED_REVIEW_DEPTHS = new Set<CouncilDepth>(["standard", "deep"]);
const SESSION_COOKIE = "rulix_session";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8;

interface CreateAppOptions {
  store?: AccountStore;
  edgeSharedSecret?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const store = options.store ?? createAccountStore();
  const edgeSharedSecret = options.edgeSharedSecret ?? process.env.RULIX_EDGE_SHARED_SECRET;
  const app = express();

  if (edgeSharedSecret) {
    app.use((req, res, next) => {
      if (req.get("x-rulix-edge-secret") !== edgeSharedSecret) {
        res.status(403).json({ error: "Requests must arrive through the trusted edge." });
        return;
      }
      next();
    });
  }

  app.use(cors({ origin: true, credentials: true }));
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

  app.post("/api/auth/register", (req, res) => {
    try {
      const session = store.registerUser({
        email: normalizeText(req.body?.email, ""),
        name: normalizeText(req.body?.name, ""),
        password: normalizeText(req.body?.password, "")
      });
      setSessionCookie(res, session);
      res.status(201).json({ user: session.user, csrfToken: session.csrfToken });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/login", (req, res) => {
    try {
      const session = store.authenticate(
        normalizeText(req.body?.email, ""),
        normalizeText(req.body?.password, "")
      );
      setSessionCookie(res, session);
      res.json({ user: session.user, csrfToken: session.csrfToken });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/auth/me", (req, res) => {
    const session = store.getSession(readSessionCookie(req));
    if (!session) {
      res.json({ user: null, csrfToken: null });
      return;
    }
    res.json({ user: session.user, csrfToken: session.session.csrfToken });
  });

  app.post("/api/auth/logout", requireAuth(store), requireCsrf, (req, res) => {
    store.destroySession(readSessionCookie(req));
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/account/state", requireAuth(store), (_req, res) => {
    res.json({ state: store.getAccountState(res.locals.user.id) });
  });

  app.put("/api/account/state", requireAuth(store), requireCsrf, (req, res) => {
    store.replaceAccountState(res.locals.user.id, req.body?.state as AccountReviewState);
    res.json({ state: store.getAccountState(res.locals.user.id) });
  });

  app.get("/api/reviews", requireAuth(store), (_req, res) => {
    res.json(store.listReviews(res.locals.user.id));
  });

  app.post("/api/reviews", requireAuth(store), requireCsrf, (req, res) => {
    const memo = createMemoRecord(req.body as Partial<NewReviewInput>, res.locals.user.name);
    store.upsertReview(res.locals.user.id, memo);
    store.appendAuditEvent(
      res.locals.user.id,
      createAuditEvent(
        memo.id,
        "Review created",
        "Review was created through the authenticated Rulix API.",
        memo.dataClass === "itar-risk" || memo.dataClass === "cui" ? "escalate" : "info",
        res.locals.user.name
      )
    );
    res.status(201).json({ review: memo });
  });

  app.get("/api/reviews/:id", requireAuth(store), (req, res) => {
    const memo = store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const state = store.getAccountState(res.locals.user.id);
    res.json({
      review: memo,
      decision: state.decisions[memo.id],
      result: state.analysisResults[memo.id],
      chatMessages: state.chatMessages[memo.id] ?? [],
      auditEvents: state.auditEvents.filter((event) => event.memoId === memo.id)
    });
  });

  app.patch("/api/reviews/:id", requireAuth(store), requireCsrf, (req, res) => {
    const memo = store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const memoText = normalizeText(req.body?.memoText, "");
    if (!memoText) {
      res.status(400).json({ error: "memoText is required." });
      return;
    }

    const updatedMemo = {
      ...memo,
      memoText,
      updatedAt: new Date().toISOString().slice(0, 10),
      status: "draft" as const
    };
    store.updateReview(res.locals.user.id, updatedMemo);
    store.appendAuditEvent(
      res.locals.user.id,
      createAuditEvent(
        memo.id,
        "Memo edited",
        "Memo text changed through the authenticated Rulix API.",
        "review",
        res.locals.user.name
      )
    );
    res.json({ review: updatedMemo });
  });

  app.post("/api/reviews/:id/analyze", requireAuth(store), requireCsrf, async (req, res) => {
    const memo = store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const state = store.getAccountState(res.locals.user.id);
    const depth = coerceReviewDepth(req.body?.depth);
    const result = await runCouncilAnalysis(memo, {
      depth,
      maxTokens: depth === "deep" ? 3600 : undefined
    });
    const updatedMemo = {
      ...memo,
      status: deriveReviewStatus(result, state.decisions[memo.id])
    };
    store.setAnalysisResult(res.locals.user.id, updatedMemo, result);
    const auditEvent = createAuditEvent(
      memo.id,
      "Analysis completed",
      result.provider.message,
      result.provider.live ? "info" : "review",
      res.locals.user.name
    );
    store.appendAuditEvent(res.locals.user.id, auditEvent);
    res.json({
      review: updatedMemo,
      result,
      auditEvents: memoAuditEvents(store, res.locals.user.id, memo.id)
    });
  });

  app.post("/api/ai/review", requireAuth(store), requireCsrf, async (req, res) => {
    const memo = coerceMemo(req.body?.memo ?? req.body);
    if (!memo) {
      res.status(400).json({ error: "Request body must include a memo with memoText." });
      return;
    }

    const depth = coerceReviewDepth(req.body?.depth);
    const result = await runCouncilAnalysis(memo, {
      depth,
      maxTokens: depth === "deep" ? 3600 : undefined
    });
    res.json({ result });
  });

  app.post("/api/reviews/:id/chat", requireAuth(store), requireCsrf, (req, res) => {
    const memo = store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found." });
      return;
    }

    const message = normalizeText(req.body?.message, "");
    if (!message) {
      res.status(400).json({ error: "Chat message is required." });
      return;
    }

    const messages = buildMemoChatMessages(memo, message);
    const fullThread = store.appendChatMessages(res.locals.user.id, memo.id, messages);
    if (messages.some((item) => item.proposedMemoText)) {
      store.appendAuditEvent(
        res.locals.user.id,
        createAuditEvent(
          memo.id,
          "Memo chat suggestion drafted",
          "Rulix drafted a memo edit from reviewer-provided context.",
          "info",
          res.locals.user.name
        )
      );
    }
    res.json({
      messages: fullThread,
      auditEvents: memoAuditEvents(store, res.locals.user.id, memo.id)
    });
  });

  app.post("/api/reviews/:id/decision", requireAuth(store), requireCsrf, (req, res) => {
    const memo = store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const decision = coerceDecision(req.body);
    if (!decision) {
      res.status(400).json({ error: "Decision requires action and notes." });
      return;
    }

    const state = store.getAccountState(res.locals.user.id);
    const result = state.analysisResults[memo.id] ?? analyzeMemo(memo);
    const updatedMemo = {
      ...memo,
      status: deriveReviewStatus(result, decision)
    };
    const decisionAuditEvent = createAuditEvent(
      memo.id,
      `Reviewer decision: ${decision.action}`,
      decision.notes,
      decision.action === "override" ? "escalate" : decision.action === "request-info" ? "review" : "info",
      res.locals.user.name
    );
    store.setDecision(res.locals.user.id, updatedMemo, decision, decisionAuditEvent);

    res.json({ review: updatedMemo, decision });
  });

  // Serve the built frontend (Vite `dist/`) so the whole app runs as one
  // service in production (e.g. AWS App Runner). No-op in dev/tests where
  // `dist/` does not exist and Vite serves the client separately.
  const distDir = process.env.RULIX_DIST_DIR
    ? path.resolve(process.env.RULIX_DIST_DIR)
    : path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  return app;
}

function memoAuditEvents(store: AccountStore, userId: string, memoId: string) {
  return store.getAccountState(userId).auditEvents.filter((event) => event.memoId === memoId);
}

function createMemoRecord(input: Partial<NewReviewInput>, owner = "API User"): MemoRecord {
  const now = new Date().toISOString().slice(0, 10);
  return {
    id: `review-${Date.now()}`,
    title: normalizeText(input.title, "New ECCN Classification Memo"),
    itemFamily: normalizeText(input.itemFamily, "Research equipment"),
    owner,
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

function reviewId(req: Request) {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

function requireAuth(store: AccountStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = store.getSession(readSessionCookie(req));
    if (!session) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    res.locals.user = session.user;
    res.locals.session = session.session;
    next();
  };
}

function requireCsrf(_req: Request, res: Response, next: NextFunction) {
  const session = res.locals.session as SessionRecord | undefined;
  const token = _req.get("x-rulix-csrf");
  if (!session || !token || token !== session.csrfToken) {
    res.status(403).json({ error: "Security token expired. Refresh and sign in again." });
    return;
  }
  next();
}

function setSessionCookie(res: Response, session: AuthSession) {
  res.cookie(SESSION_COOKIE, session.rawToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/"
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

function readSessionCookie(req: Request) {
  return parseCookies(req.get("cookie"))[SESSION_COOKIE];
}

function parseCookies(header: string | undefined) {
  if (!header) return {} as Record<string, string>;
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [name, ...valueParts] = part.trim().split("=");
      return [decodeURIComponent(name), decodeURIComponent(valueParts.join("="))];
    })
  );
}

function sendStoreError(res: Response, error: unknown) {
  if (error instanceof StoreError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Unexpected account error." });
}

function buildMemoChatMessages(memo: MemoRecord, reviewerMessage: string): MemoChatMessage[] {
  const now = new Date().toISOString();
  const userMessage: MemoChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    memoId: memo.id,
    role: "user",
    text: reviewerMessage,
    createdAt: now
  };
  const wantsMemoEdit = /\b(add|append|include|update|edit|revise|change|insert|clarify)\b/i.test(
    reviewerMessage
  );
  const proposedMemoText = wantsMemoEdit
    ? appendReviewerContext(memo.memoText, reviewerMessage)
    : undefined;
  const assistantMessage: MemoChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    memoId: memo.id,
    role: "assistant",
    text: proposedMemoText
      ? "I drafted a memo update from that context. Review it, then apply it to clear prior analysis and re-run the review."
      : "I can help turn reviewer context into memo language. Ask me to add, revise, clarify, or insert the information you want reflected in the memo.",
    createdAt: now,
    proposedMemoText
  };
  return [userMessage, assistantMessage];
}

function appendReviewerContext(currentMemoText: string, reviewerMessage: string) {
  const cleaned = reviewerMessage
    .replace(/\s+/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
  const heading = "## Reviewer-supplied context";
  const line = `- ${cleaned}`;

  if (currentMemoText.includes(heading)) {
    return `${currentMemoText.trim()}\n${line}\n`;
  }

  return `${currentMemoText.trim()}\n\n${heading}\n${line}\n`;
}

function coerceReviewDepth(value: unknown): CouncilDepth {
  return typeof value === "string" && ALLOWED_REVIEW_DEPTHS.has(value as CouncilDepth)
    ? (value as CouncilDepth)
    : "standard";
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
