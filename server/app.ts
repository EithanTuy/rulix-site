import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { officialCorpus } from "../src/data/corpus";
import { outreachLeads } from "../src/outreachLeads";
import { analyzeMemo } from "../src/lib/eccnReview";
import { createAuditEvent, deriveReviewStatus } from "../src/lib/reviewLifecycle";
import type {
  AccountReviewState,
  AuditEvent,
  MemoChatMessage,
  MemoRecord,
  NewReviewInput,
  OutreachDraft,
  ReviewerDecision,
  UsageEvent,
  UserProfile
} from "../src/types";
import {
  draftMemoFromPublicWeb,
  getBedrockRuntime,
  runCouncilAnalysis,
  runMemoChatWithHaiku,
  type CouncilDepth,
  type UsageSample
} from "./bedrockCouncil";
import {
  StoreError,
  createAccountStore,
  sessionTtlMs,
  type AccountStore,
  type AuthSession,
  type SessionRecord
} from "./store";
import { buildAdminMetrics, summarizeUsers } from "./metrics";
import { sendInviteEmail, sendPasswordResetEmail } from "./email";
import { generateOutreachDraft, outreachModel, outreachReady } from "./outreachWriter";

const ALLOWED_REVIEW_DEPTHS = new Set<CouncilDepth>(["standard", "deep"]);
const SESSION_COOKIE = "rulix_session";

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
    const provider = getBedrockRuntime();
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

  app.post("/api/auth/register", (_req, res) => {
    res.status(410).json({ error: "Accounts are invite-only. Use an invite link to create a workspace." });
  });

  app.post("/api/auth/bootstrap-invite", async (req, res) => {
    const bootstrapSecret = process.env.AUTH_BOOTSTRAP_SECRET;
    if (!bootstrapSecret || req.get("x-rulix-bootstrap-secret") !== bootstrapSecret) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    try {
      const invite = await store.createInvite({
        email: normalizeText(req.body?.email, ""),
        name: normalizeText(req.body?.name, ""),
        role: coerceUserRole(req.body?.role) ?? "export-control-officer",
        invitedBy: "bootstrap"
      });
      const delivery = await sendInviteEmail(invite);
      res.status(201).json({ invite: invite.invite, inviteLink: invite.inviteLink, delivery });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/auth/invites", requireAuth(store), requireAdmin, async (_req, res) => {
    res.json({ invites: await store.listInvites() });
  });

  app.post("/api/auth/invites", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    try {
      const invite = await store.createInvite({
        email: normalizeText(req.body?.email, ""),
        name: normalizeText(req.body?.name, ""),
        role: coerceUserRole(req.body?.role) ?? "reviewer",
        invitedBy: res.locals.user.email
      });
      const delivery = await sendInviteEmail(invite);
      res.status(201).json({ invite: invite.invite, inviteLink: invite.inviteLink, delivery });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/admin/metrics", requireAuth(store), requireAdmin, async (req, res) => {
    const rangeDays = coercePositiveInt(req.query.rangeDays, 30);
    const [usage, users, sessions] = await Promise.all([
      store.getUsage(rangeDays),
      store.listUsers(),
      store.listActiveSessions()
    ]);
    res.json({ metrics: buildAdminMetrics({ usage, users, sessions, rangeDays }) });
  });

  app.get("/api/admin/users", requireAuth(store), requireAdmin, async (_req, res) => {
    const [usage, users, sessions] = await Promise.all([
      store.getUsage(),
      store.listUsers(),
      store.listActiveSessions()
    ]);
    res.json({ users: summarizeUsers({ users, usage, sessions }) });
  });

  app.get("/api/admin/outreach", requireAuth(store), requireAdmin, async (_req, res) => {
    const state = await store.getAccountState(res.locals.user.id);
    res.json({
      leads: outreachLeads,
      drafts: state.outreachDrafts ?? {},
      bedrock: {
        ready: outreachReady(),
        model: outreachModel(),
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
      }
    });
  });

  app.post("/api/admin/outreach/generate", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const lead = outreachLeads.find((item) => item.leadId === normalizeText(req.body?.leadId, ""));
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    try {
      const draft = await generateOutreachDraft(
        lead,
        normalizeText(req.body?.direction, ""),
        (sample) => recordUsageSafe(store, res.locals.user, sample)
      );
      const state = await store.getAccountState(res.locals.user.id);
      (state.outreachDrafts ??= {})[lead.leadId] = draft;
      await store.replaceAccountState(res.locals.user.id, state);
      res.json({ lead, draft });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "Bedrock generation failed." });
    }
  });

  app.put("/api/admin/outreach/drafts/:leadId", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const lead = outreachLeads.find((item) => item.leadId === req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    const subject = normalizeText(req.body?.subject, "");
    const body = normalizeText(req.body?.body, "");
    if (!subject || !body) {
      res.status(400).json({ error: "Subject and body are required." });
      return;
    }
    const state = await store.getAccountState(res.locals.user.id);
    const previous = state.outreachDrafts?.[lead.leadId];
    const draft: OutreachDraft = {
      leadId: lead.leadId,
      organization: lead.organization,
      email: lead.email,
      subject,
      body,
      model: previous?.model ?? outreachModel(),
      generatedAt: previous?.generatedAt,
      sentAt: previous?.sentAt,
      updatedAt: new Date().toISOString()
    };
    (state.outreachDrafts ??= {})[lead.leadId] = draft;
    await store.replaceAccountState(res.locals.user.id, state);
    res.json({ lead, draft });
  });

  app.post("/api/admin/outreach/drafts/:leadId/mark-sent", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const state = await store.getAccountState(res.locals.user.id);
    const draft = state.outreachDrafts?.[req.params.leadId];
    if (!draft) {
      res.status(404).json({ error: "Save a draft before marking it sent." });
      return;
    }
    draft.sentAt = new Date().toISOString();
    draft.updatedAt = draft.sentAt;
    await store.replaceAccountState(res.locals.user.id, state);
    res.json({ draft });
  });

  app.get("/api/auth/invites/:token", async (req, res) => {
    try {
      res.json({ invite: await store.getInviteByToken(authToken(req)) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/invite/accept", async (req, res) => {
    try {
      const session = await store.acceptInvite(
        normalizeText(req.body?.token, ""),
        normalizeText(req.body?.password, ""),
        normalizeText(req.body?.name, "")
      );
      setSessionCookie(res, session);
      res.status(201).json({ user: session.user, csrfToken: session.csrfToken });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const session = await store.authenticate(
        normalizeText(req.body?.email, ""),
        normalizeText(req.body?.password, "")
      );
      setSessionCookie(res, session);
      res.json({ user: session.user, csrfToken: session.csrfToken });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/password-reset/request", async (req, res) => {
    try {
      const reset = await store.requestPasswordReset(normalizeText(req.body?.email, ""));
      if (reset.resetLink) await sendPasswordResetEmail(reset);
      res.json({ ok: true });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/auth/password-reset/:token", async (req, res) => {
    try {
      res.json({ reset: await store.getPasswordResetByToken(authToken(req)) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/password-reset/complete", async (req, res) => {
    try {
      const session = await store.completePasswordReset(
        normalizeText(req.body?.token, ""),
        normalizeText(req.body?.password, "")
      );
      setSessionCookie(res, session);
      res.json({ user: session.user, csrfToken: session.csrfToken });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    const session = await store.getSession(readSessionCookie(req));
    if (!session) {
      res.json({ user: null, csrfToken: null });
      return;
    }
    res.json({ user: session.user, csrfToken: session.session.csrfToken });
  });

  app.post("/api/auth/logout", requireAuth(store), requireCsrf, async (req, res) => {
    await store.destroySession(readSessionCookie(req));
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/account/state", requireAuth(store), async (_req, res) => {
    res.json({ state: await store.getAccountState(res.locals.user.id) });
  });

  app.put("/api/account/state", requireAuth(store), requireCsrf, async (req, res) => {
    await store.replaceAccountState(res.locals.user.id, req.body?.state as AccountReviewState);
    res.json({ state: await store.getAccountState(res.locals.user.id) });
  });

  app.get("/api/reviews", requireAuth(store), async (_req, res) => {
    res.json(await store.listReviews(res.locals.user.id));
  });

  app.post("/api/reviews", requireAuth(store), requireCsrf, async (req, res) => {
    const memo = createMemoRecord(req.body as Partial<NewReviewInput>, res.locals.user.name);
    try {
      await store.upsertReview(res.locals.user.id, memo);
      await store.appendAuditEvent(
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
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/reviews/:id", requireAuth(store), async (req, res) => {
    const memo = await store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const state = await store.getAccountState(res.locals.user.id);
    res.json({
      review: memo,
      decision: state.decisions[memo.id],
      result: state.analysisResults[memo.id],
      chatMessages: state.chatMessages[memo.id] ?? [],
      auditEvents: state.auditEvents.filter((event) => event.memoId === memo.id)
    });
  });

  app.patch("/api/reviews/:id", requireAuth(store), requireCsrf, async (req, res) => {
    const memo = await store.findReview(res.locals.user.id, reviewId(req));
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
    await store.updateReview(res.locals.user.id, updatedMemo);
    await store.appendAuditEvent(
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
    const memo = await store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const state = await store.getAccountState(res.locals.user.id);
    const depth = coerceReviewDepth(req.body?.depth);
    const result = await runCouncilAnalysis(memo, {
      depth,
      maxTokens: depth === "deep" ? 3600 : undefined,
      onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample)
    });
    const updatedMemo = {
      ...memo,
      status: deriveReviewStatus(result, state.decisions[memo.id])
    };
    await store.setAnalysisResult(res.locals.user.id, updatedMemo, result);
    const auditEvent = createAuditEvent(
      memo.id,
      "Analysis completed",
      result.provider.message,
      result.provider.live ? "info" : "review",
      res.locals.user.name
    );
    await store.appendAuditEvent(res.locals.user.id, auditEvent);
    res.json({
      review: updatedMemo,
      result,
      auditEvents: await memoAuditEvents(store, res.locals.user.id, memo.id)
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
      maxTokens: depth === "deep" ? 3600 : undefined,
      onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample)
    });
    res.json({ result });
  });

  app.post("/api/public-memo-draft", requireAuth(store), requireCsrf, async (req, res) => {
    const item = normalizeText(req.body?.item, "");
    if (!item) {
      res.status(400).json({ error: "Item description is required." });
      return;
    }

    const draft = await draftMemoFromPublicWeb(item, {
      onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample)
    });
    res.json(draft);
  });

  app.post("/api/reviews/:id/chat", requireAuth(store), requireCsrf, async (req, res) => {
    const memo = await store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found." });
      return;
    }

    const message = normalizeText(req.body?.message, "");
    if (!message) {
      res.status(400).json({ error: "Chat message is required." });
      return;
    }

    const history = (await store.getAccountState(res.locals.user.id)).chatMessages[memo.id] ?? [];
    const messages = await buildMemoChatMessages(memo, message, history, (sample) =>
      recordUsageSafe(store, res.locals.user, sample)
    );
    const fullThread = await store.appendChatMessages(res.locals.user.id, memo.id, messages);
    if (messages.some((item) => item.proposedMemoText)) {
      await store.appendAuditEvent(
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
      auditEvents: await memoAuditEvents(store, res.locals.user.id, memo.id)
    });
  });

  app.post("/api/reviews/:id/decision", requireAuth(store), requireCsrf, async (req, res) => {
    const memo = await store.findReview(res.locals.user.id, reviewId(req));
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const decision = coerceDecision(req.body);
    if (!decision) {
      res.status(400).json({ error: "Decision requires action and notes." });
      return;
    }

    const state = await store.getAccountState(res.locals.user.id);
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
    await store.setDecision(res.locals.user.id, updatedMemo, decision, decisionAuditEvent);

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

async function memoAuditEvents(store: AccountStore, userId: string, memoId: string) {
  return (await store.getAccountState(userId)).auditEvents.filter((event) => event.memoId === memoId);
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

function authToken(req: Request) {
  const raw = req.params.token;
  return Array.isArray(raw) ? raw[0] : raw ?? "";
}

function coerceUserRole(value: unknown): UserProfile["role"] | undefined {
  return value === "export-control-officer" ||
    value === "reviewer" ||
    value === "submitter" ||
    value === "counsel"
    ? value
    : undefined;
}

function requireAuth(store: AccountStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await store.getSession(readSessionCookie(req));
    if (!session) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    res.locals.user = session.user;
    res.locals.session = session.session;
    next();
  };
}

function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  const user = res.locals.user as UserProfile | undefined;
  if (user?.role !== "export-control-officer") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
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
    maxAge: sessionTtlMs(),
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

// Persist a Bedrock usage sample for the admin dashboard. Best-effort: a
// failure here must never affect the user-facing AI response.
function recordUsageSafe(store: AccountStore, user: UserProfile, sample: UsageSample) {
  const event: UsageEvent = {
    id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    userId: user.id,
    userEmail: user.email,
    at: new Date().toISOString(),
    model: sample.model,
    callType: sample.callType,
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    cacheReadTokens: sample.cacheReadTokens,
    cacheWriteTokens: sample.cacheWriteTokens,
    latencyMs: sample.latencyMs
  };
  void store.recordUsage(event).catch(() => undefined);
}

function coercePositiveInt(value: unknown, fallback: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function buildMemoChatMessages(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[],
  onUsage?: (sample: UsageSample) => void
): Promise<MemoChatMessage[]> {
  const now = new Date().toISOString();
  const trimmedMessage = reviewerMessage.trim();
  const userMessage: MemoChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    memoId: memo.id,
    role: "user",
    text: trimmedMessage,
    createdAt: now
  };

  const aiResult = await runMemoChatWithHaiku(memo, trimmedMessage, history, { onUsage }).catch(
    () => undefined
  );
  if (aiResult) {
    return [
      userMessage,
      {
        id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        memoId: memo.id,
        role: "assistant",
        text: aiResult.text,
        createdAt: now,
        proposedMemoText: aiResult.proposedMemoText
      }
    ];
  }

  const localResult = buildLocalMemoChatResult(memo, trimmedMessage);
  const assistantMessage: MemoChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    memoId: memo.id,
    role: "assistant",
    text: localResult.text,
    createdAt: now,
    proposedMemoText: localResult.proposedMemoText
  };
  return [userMessage, assistantMessage];
}

function buildLocalMemoChatResult(memo: MemoRecord, reviewerMessage: string) {
  const wantsMemoEdit = /\b(add|append|include|update|edit|revise|change|insert|clarify)\b/i.test(
    reviewerMessage
  );
  if (wantsMemoEdit) {
    return {
      text: `Live memo chat is unavailable, so I drafted a simple memo update using: "${reviewerMessage}".`,
      proposedMemoText: appendReviewerContext(memo.memoText, reviewerMessage)
    };
  }
  return { text: buildMemoAwareChatReply(memo, reviewerMessage) };
}

function buildMemoAwareChatReply(memo: MemoRecord, reviewerMessage: string) {
  const matchedSentences = findRelevantMemoSentences(memo.memoText, reviewerMessage);
  const memoContext = matchedSentences.length
    ? `I found relevant memo language: ${matchedSentences.map((sentence) => `"${sentence}"`).join(" ")}`
    : `I do not see an exact match for that in ${memo.documentCode}.`;

  if (/\b(missing|gap|need|needs|block|blocked|risk)\b/i.test(reviewerMessage)) {
    return `${memoContext} If this affects signoff, add the missing fact to the memo or run analysis to surface the blocker in the evidence panel.`;
  }

  if (/\b(eccn|ear99|classification|classify|category|control)\b/i.test(reviewerMessage)) {
    return `${memoContext} For classification support, compare that language against the recommendation and source citations after running AI analysis.`;
  }

  if (/\b(summary|summarize|what does|explain)\b/i.test(reviewerMessage)) {
    return `${memo.title} is tracked as ${memo.documentCode} for ${memo.itemFamily}. ${memoContext}`;
  }

  return `${memoContext} Ask me to add, revise, clarify, or insert this context if you want me to draft memo text.`;
}

function findRelevantMemoSentences(memoText: string, reviewerMessage: string) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "can",
    "does",
    "for",
    "from",
    "has",
    "have",
    "how",
    "into",
    "memo",
    "that",
    "the",
    "this",
    "what",
    "with",
    "you"
  ]);
  const terms = Array.from(
    new Set(
      reviewerMessage
        .toLowerCase()
        .match(/[a-z0-9.-]{4,}/g)
        ?.filter((term) => !stopWords.has(term)) ?? []
    )
  );
  if (!terms.length) return [];

  return memoText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => ({
      sentence,
      score: terms.filter((term) => sentence.toLowerCase().includes(term)).length
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.sentence.length - b.sentence.length)
    .slice(0, 2)
    .map((match) => match.sentence.length > 220 ? `${match.sentence.slice(0, 217)}...` : match.sentence);
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
