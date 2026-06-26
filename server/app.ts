import { existsSync, readFileSync } from "node:fs";
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
  OutreachDraft,
  LeadSearchRun,
  LeadWorkflow,
  OutreachJob,
  ReviewerDecision,
  UsageEvent,
  UserProfile
} from "../src/types";
import {
  draftMemoFromPublicWeb,
  getBedrockRuntime,
  runCouncilAnalysis,
  runMemoBuildChat,
  runMemoChatWithHaiku,
  type CouncilDepth,
  type MemoBuildChatMessage,
  type UsageSample
} from "./bedrockCouncil";
import { extractDocumentText } from "./documentExtraction";
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
import {
  generateOutreachDraft,
  outreachModel,
  personalizeOutreachDraft,
  personalizationModel
} from "./outreachWriter";
import { discoverLeads, leadSearchModel } from "./leadSearch";
import { maskApiKey, outreachProviderReady } from "./aiClient";
import {
  createOutreachJob,
  estimateJobCost,
  mergeOutreachLeads,
  scheduleOutreachJob
} from "./outreachJobs";

const ALLOWED_REVIEW_DEPTHS = new Set<CouncilDepth>(["standard", "deep"]);
const SESSION_COOKIE = "rulix_session";
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://app.rulix.cloud",
  "https://dashboard.rulix.cloud"
]);
const PUBLIC_SITE_HOSTS = new Set(["rulix.cloud", "www.rulix.cloud"]);
const MARKETING_SITE_PAGES = [
  {
    path: "/",
    title: "Rulix - Defensible export-control memo review",
    description:
      "Rulix checks classification memos for missing thresholds, weak evidence, and reviewer questions before human export-control reviewers sign off."
  },
  {
    path: "/export-control-memo-review",
    title: "Export-control memo review software | Rulix",
    description:
      "Review export-control classification memos for evidence gaps, missing technical thresholds, reviewer questions, and audit-ready signoff."
  },
  {
    path: "/eccn-classification-assistant",
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps export-control reviewers structure ECCN classification review, evidence gaps, and human signoff without replacing expert judgment."
  },
  {
    path: "/ai-export-compliance-review",
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI decision support to spot export-control memo gaps while keeping final determinations with trained human reviewers."
  },
  {
    path: "/university-export-control-review",
    title: "University export-control memo review | Rulix",
    description:
      "Rulix helps universities and research operations triage public or sanitized export-control memo drafts before empowered officials spend review time."
  },
  {
    path: "/manufacturer-eccn-review",
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Rulix helps manufacturers and labs reduce back-and-forth on ECCN memo evidence, product specifications, and reviewer-ready questions."
  }
];

interface CreateAppOptions {
  store?: AccountStore;
  edgeSharedSecret?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const store = options.store ?? createAccountStore();
  const edgeSharedSecret = options.edgeSharedSecret ?? process.env.RULIX_EDGE_SHARED_SECRET;
  const app = express();
  const allowedOrigins = allowedCorsOrigins();

  app.disable("x-powered-by");
  app.use(appSecurityHeaders);

  if (edgeSharedSecret) {
    app.use((req, res, next) => {
      if (req.get("x-rulix-edge-secret") !== edgeSharedSecret) {
        res.status(403).json({ error: "Requests must arrive through the trusted edge." });
        return;
      }
      next();
    });
  }

  app.use(cors({
    origin: (origin, callback) => {
      callback(null, isCorsOriginAllowed(origin, allowedOrigins));
    },
    credentials: true
  }));
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (_req, res) => {
    const provider = getBedrockRuntime();
    res.json({
      ok: true,
      service: "rulix-eccn-api",
      phase: "phase-2-mvp",
      time: new Date().toISOString(),
      provider: {
        configured: provider.configured
      }
    });
  });

  app.get("/api/corpus", (_req, res) => {
    res.json(officialCorpus);
  });

  app.get("/robots.txt", (req, res) => {
    if (isPublicMarketingHost(req)) {
      res
        .type("text/plain")
        .send("User-agent: *\nAllow: /\n\nSitemap: https://rulix.cloud/sitemap.xml\n");
      return;
    }
    if (shouldNoindexApp(req)) {
      res.type("text/plain").send("User-agent: *\nDisallow: /\n");
      return;
    }
    res.status(404).type("text/plain").send("Not found");
  });

  app.get("/sitemap.xml", (req, res) => {
    if (isPublicMarketingHost(req)) {
      res.type("application/xml").send(marketingSitemapXml());
      return;
    }
    if (shouldNoindexApp(req)) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    res.status(404).type("text/plain").send("Not found");
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

  app.get("/api/admin/outreach-config", requireAuth(store), requireAdmin, async (_req, res) => {
    const config = await store.getOutreachConfig();
    res.json({
      provider: config.provider,
      anthropicKeyMasked: config.anthropicApiKey ? maskApiKey(config.anthropicApiKey) : undefined
    });
  });

  app.put("/api/admin/outreach-config", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const provider = req.body?.provider === "anthropic" ? "anthropic" as const : "bedrock" as const;
    const anthropicApiKey = typeof req.body?.anthropicApiKey === "string"
      ? req.body.anthropicApiKey.trim() || undefined
      : undefined;
    if (provider === "anthropic" && !anthropicApiKey) {
      res.status(400).json({ error: "An Anthropic API key is required when using the direct API." });
      return;
    }
    await store.setOutreachConfig({ provider, anthropicApiKey });
    res.json({
      provider,
      anthropicKeyMasked: anthropicApiKey ? maskApiKey(anthropicApiKey) : undefined
    });
  });

  app.get("/api/admin/outreach", requireAuth(store), requireAdmin, async (_req, res) => {
    const [state, config] = await Promise.all([
      store.getAccountState(res.locals.user.id),
      store.getOutreachConfig()
    ]);
    const leads = mergeOutreachLeads(state.discoveredLeads ?? []);
    res.json({
      leads,
      drafts: state.outreachDrafts ?? {},
      leadSearchRuns: state.leadSearchRuns ?? [],
      leadWorkflows: state.leadWorkflows ?? {},
      outreachJobs: state.outreachJobs ?? [],
      bedrock: {
        ready: outreachProviderReady(config),
        provider: config.provider,
        model: outreachModel(),
        personalizationModel: personalizationModel(),
        leadSearchModel: leadSearchModel(),
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
      }
    });
  });

  app.post("/api/admin/outreach/generate", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const [state, config] = await Promise.all([
      store.getAccountState(res.locals.user.id),
      store.getOutreachConfig()
    ]);
    const lead = mergeOutreachLeads(state.discoveredLeads ?? [])
      .find((item) => item.leadId === normalizeText(req.body?.leadId, ""));
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    try {
      const draft = await generateOutreachDraft(
        lead,
        normalizeText(req.body?.direction, ""),
        (sample) => recordUsageSafe(store, res.locals.user, sample),
        config
      );
      (state.outreachDrafts ??= {})[lead.leadId] = draft;
      setLeadWorkflow(state, lead.leadId, {
        reviewStatus: "pending-review",
        lifecycleStatus: "drafted"
      });
      await store.replaceAccountState(res.locals.user.id, state);
      res.json({ lead, draft });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "Bedrock generation failed." });
    }
  });

  app.put("/api/admin/outreach/drafts/:leadId", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const state = await store.getAccountState(res.locals.user.id);
    const lead = mergeOutreachLeads(state.discoveredLeads ?? [])
      .find((item) => item.leadId === req.params.leadId);
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
      personalizationStatus: previous?.personalizationStatus,
      personalizationDetail: previous?.personalizationDetail,
      personalizationRelevance: previous?.personalizationRelevance,
      personalizationSourceTitle: previous?.personalizationSourceTitle,
      personalizationSourceUrl: previous?.personalizationSourceUrl,
      personalizationVerifiedAt: previous?.personalizationVerifiedAt,
      personalizationConfidence: previous?.personalizationConfidence,
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
    setLeadWorkflow(state, req.params.leadId, {
      reviewStatus: "approved",
      lifecycleStatus: "sent",
      lastContactedAt: draft.sentAt
    });
    await store.replaceAccountState(res.locals.user.id, state);
    res.json({ draft });
  });

  app.post("/api/admin/outreach/drafts/:leadId/personalize", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const [state, config] = await Promise.all([
      store.getAccountState(res.locals.user.id),
      store.getOutreachConfig()
    ]);
    const lead = mergeOutreachLeads(state.discoveredLeads ?? [])
      .find((item) => item.leadId === req.params.leadId);
    const draft = state.outreachDrafts?.[req.params.leadId];
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    if (!draft) {
      res.status(404).json({ error: "Create a draft before personalizing it." });
      return;
    }
    try {
      const personalized = await personalizeOutreachDraft(
        lead,
        draft,
        (sample) => recordUsageSafe(store, res.locals.user, sample),
        config
      );
      (state.outreachDrafts ??= {})[lead.leadId] = personalized;
      setLeadWorkflow(state, lead.leadId, {
        reviewStatus: personalized.personalizationStatus === "personalized" ? "pending-review" : "needs-research",
        lifecycleStatus: personalized.personalizationStatus === "personalized" ? "personalized" : "drafted"
      });
      await store.replaceAccountState(res.locals.user.id, state);
      res.json({ lead, draft: personalized });
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "Personalization failed."
      });
    }
  });

  app.put("/api/admin/leads/:leadId/workflow", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const state = await store.getAccountState(res.locals.user.id);
    const lead = mergeOutreachLeads(state.discoveredLeads ?? [])
      .find((item) => item.leadId === req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    const reviewStatus = coerceReviewStatus(req.body?.reviewStatus);
    const lifecycleStatus = coerceLifecycleStatus(req.body?.lifecycleStatus);
    if (!reviewStatus || !lifecycleStatus) {
      res.status(400).json({ error: "Valid review and lifecycle statuses are required." });
      return;
    }
    const workflow = setLeadWorkflow(state, lead.leadId, {
      reviewStatus,
      lifecycleStatus,
      assignedOwner: normalizeOptional(req.body?.assignedOwner),
      notes: normalizeOptional(req.body?.notes),
      lastContactedAt: normalizeIsoDate(req.body?.lastContactedAt),
      followUpAt: normalizeIsoDate(req.body?.followUpAt),
      replyStatus: normalizeOptional(req.body?.replyStatus)
    });
    await store.replaceAccountState(res.locals.user.id, state);
    res.json({ lead, workflow });
  });

  app.post("/api/admin/outreach/jobs", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const state = await store.getAccountState(res.locals.user.id);
    const type = coerceOutreachJobType(req.body?.type);
    if (!type) {
      res.status(400).json({ error: "Unknown outreach job type." });
      return;
    }
    const leads = mergeOutreachLeads(state.discoveredLeads ?? []);
    const itemIds = type === "draft-missing"
      ? leads.filter((lead) => !state.outreachDrafts?.[lead.leadId]).map((lead) => lead.leadId)
      : type === "personalize-all"
        ? leads.filter((lead) => {
            const draft = state.outreachDrafts?.[lead.leadId];
            return Boolean(draft && !draft.sentAt);
          }).map((lead) => lead.leadId)
        : [];
    const job = createOutreachJob({
      type,
      itemIds,
      maxCostUsd: clampNumber(Number(req.body?.maxCostUsd) || 5, 0.05, 100),
      maxRetries: clampNumber(Number(req.body?.maxRetries) || 2, 0, 5),
      direction: normalizeOptional(req.body?.direction),
      searchDurationSeconds: clampNumber(Number(req.body?.searchDurationSeconds) || 30, 15, 45)
    });
    job.estimatedCostUsd = estimateJobCost(job);
    if (type !== "lead-search" && itemIds.length === 0) {
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.logs.unshift({
        at: job.completedAt,
        message: "No eligible items were found.",
        level: "success"
      });
    }
    state.outreachJobs = [job, ...(state.outreachJobs ?? [])].slice(0, 40);
    await store.replaceAccountState(res.locals.user.id, state);
    if (job.status === "queued") {
      await scheduleOutreachJob({
        source: "rulix.outreach-worker",
        userId: res.locals.user.id,
        userEmail: res.locals.user.email,
        jobId: job.id
      });
    }
    res.status(202).json({ job });
  });

  app.post("/api/admin/outreach/jobs/:jobId/:action", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const action = req.params.action;
    if (!["pause", "resume", "retry", "terminate"].includes(action)) {
      res.status(400).json({ error: "Unknown job action." });
      return;
    }
    const state = await store.getAccountState(res.locals.user.id);
    const job = state.outreachJobs?.find((candidate) => candidate.id === req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Outreach job not found." });
      return;
    }
    if (action === "terminate") {
      if (job.status !== "completed" && job.status !== "terminated") {
        const now = new Date().toISOString();
        job.status = "terminated";
        job.completedAt = now;
        job.error = undefined;
        job.logs.unshift({
          at: now,
          message: "Terminated by operator. Any in-flight result will be discarded.",
          level: "warning"
        });
      }
    } else if (job.status === "terminated" || job.status === "completed") {
      res.status(409).json({ error: `A ${job.status} job cannot be ${action}d.` });
      return;
    } else if (action === "pause") {
      job.status = "paused";
      job.logs.unshift({ at: new Date().toISOString(), message: "Paused by operator.", level: "warning" });
    } else {
      job.status = "queued";
      job.error = undefined;
      if (action === "retry") job.retryCount = 0;
      job.logs.unshift({
        at: new Date().toISOString(),
        message: `${action === "retry" ? "Retry" : "Resume"} requested by operator.`,
        level: "info"
      });
    }
    job.updatedAt = new Date().toISOString();
    await store.replaceAccountState(res.locals.user.id, state);
    if (job.status === "queued") {
      await scheduleOutreachJob({
        source: "rulix.outreach-worker",
        userId: res.locals.user.id,
        userEmail: res.locals.user.email,
        jobId: job.id
      });
    }
    res.json({ job });
  });

  app.post("/api/admin/leads/search", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const durationSeconds = clampNumber(Number(req.body?.durationSeconds) || 30, 15, 45);
    const startedAt = new Date().toISOString();
    const [state, config] = await Promise.all([
      store.getAccountState(res.locals.user.id),
      store.getOutreachConfig()
    ]);
    const existingLeads = mergeOutreachLeads(state.discoveredLeads ?? []);
    try {
      const result = await discoverLeads({
        existingLeads,
        durationSeconds,
        onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample),
        config
      });
      state.discoveredLeads = mergeOutreachLeads([
        ...(state.discoveredLeads ?? []),
        ...result.leads
      ]).filter((lead) => lead.leadId.startsWith("AI-"));
      const run: LeadSearchRun = {
        id: `lead-search-${Date.now()}`,
        startedAt,
        completedAt: new Date().toISOString(),
        durationSeconds,
        model: result.model,
        status: "completed",
        addedLeadIds: result.leads.map((lead) => lead.leadId),
        activity: result.activity
      };
      state.leadSearchRuns = [run, ...(state.leadSearchRuns ?? [])].slice(0, 20);
      await store.replaceAccountState(res.locals.user.id, state);
      res.json({ leads: mergeOutreachLeads(state.discoveredLeads), run });
    } catch (error) {
      const run: LeadSearchRun = {
        id: `lead-search-${Date.now()}`,
        startedAt,
        completedAt: new Date().toISOString(),
        durationSeconds,
        model: leadSearchModel(),
        status: "failed",
        addedLeadIds: [],
        activity: [
          { at: startedAt, message: `Started a ${durationSeconds}-second lead research budget.` },
          { at: new Date().toISOString(), message: "Lead search stopped before candidates were saved." }
        ],
        error: error instanceof Error ? error.message : "Lead search failed."
      };
      state.leadSearchRuns = [run, ...(state.leadSearchRuns ?? [])].slice(0, 20);
      await store.replaceAccountState(res.locals.user.id, state);
      res.status(502).json({ error: run.error, run });
    }
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

  app.post("/api/documents/extract", requireAuth(store), requireCsrf, async (req, res) => {
    const fileName = normalizeText(req.body?.fileName, "attached-document");
    const mediaType = normalizeText(req.body?.mediaType, "application/octet-stream");
    const dataBase64 = normalizeText(req.body?.dataBase64, "");
    if (!dataBase64) {
      res.status(400).json({ error: "Document data is required." });
      return;
    }

    try {
      const extraction = await extractDocumentText(
        { fileName, mediaType, dataBase64 },
        { onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample) }
      );
      res.json({ extraction });
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "Document extraction failed."
      });
    }
  });

  app.post("/api/ai/memo-builder-chat", requireAuth(store), requireCsrf, async (req, res) => {
    const raw = req.body?.messages;
    if (!Array.isArray(raw) || raw.length === 0) {
      res.status(400).json({ error: "messages array is required." });
      return;
    }
    const messages: MemoBuildChatMessage[] = raw
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));
    if (messages.length === 0 || messages[0].role !== "user") {
      res.status(400).json({ error: "First message must be from the user." });
      return;
    }
    try {
      const result = await runMemoBuildChat(messages, {
        onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample)
      });
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "Memo Builder AI failed." });
    }
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
      if (shouldNoindexApp(req)) {
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
      }
      const indexHtml = readFileSync(path.join(distDir, "index.html"), "utf8");
      res.type("html").send(renderIndexHtml(indexHtml, req));
    });
  }

  return app;
}

function appSecurityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "upgrade-insecure-requests"
  ].join("; "));
  if (req.secure || req.get("x-forwarded-proto") === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  if (shouldNoindexApp(req)) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  }
  next();
}

function allowedCorsOrigins() {
  const configured = (process.env.RULIX_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: Set<string>) {
  if (!origin) return true;
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return true;
  }
  return allowedOrigins.has(origin);
}

function isPrivateAppHost(req: Request) {
  const host = requestHost(req);
  return host === "app.rulix.cloud" || host === "dashboard.rulix.cloud";
}

function isPublicMarketingHost(req: Request) {
  return PUBLIC_SITE_HOSTS.has(requestHost(req));
}

function requestHost(req: Request) {
  return (
    req.get("x-forwarded-host") ??
    req.get("x-original-host") ??
    req.hostname ??
    req.get("host") ??
    ""
  ).split(",")[0].split(":")[0].toLowerCase();
}

function shouldNoindexApp(req: Request) {
  return !isPublicMarketingHost(req);
}

function marketingSitemapXml() {
  const urls = MARKETING_SITE_PAGES.map((page) => {
    const priority = page.path === "/" ? "1.0" : "0.8";
    const changefreq = page.path === "/" ? "weekly" : "monthly";
    return [
      "  <url>",
      `    <loc>https://rulix.cloud${page.path}</loc>`,
      `    <changefreq>${changefreq}</changefreq>`,
      `    <priority>${priority}</priority>`,
      "  </url>"
    ].join("\n");
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function renderIndexHtml(indexHtml: string, req: Request) {
  if (!isPublicMarketingHost(req)) return indexHtml;
  const meta = marketingMetaForPath(req.path);
  const canonical = `https://rulix.cloud${meta.path}`;
  const cleanHtml = indexHtml
    .replace(/^\s*<meta name="description"[^>]*>\r?\n?/im, "")
    .replace(/^\s*<link rel="canonical"[^>]*>\r?\n?/im, "")
    .replace(/^\s*<meta property="og:[^"]+"[^>]*>\r?\n?/gim, "")
    .replace(/^\s*<meta name="twitter:card"[^>]*>\r?\n?/im, "");
  return cleanHtml
    .replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`)
    .replace(
      "</head>",
      [
        `    <meta name="description" content="${escapeHtml(meta.description)}" />`,
        `    <link rel="canonical" href="${canonical}" />`,
        `    <meta property="og:title" content="${escapeHtml(meta.title)}" />`,
        `    <meta property="og:description" content="${escapeHtml(meta.description)}" />`,
        `    <meta property="og:type" content="website" />`,
        `    <meta property="og:url" content="${canonical}" />`,
        `    <meta property="og:image" content="https://rulix.cloud/marketing/rulix-audit-product.png" />`,
        `    <meta name="twitter:card" content="summary_large_image" />`,
        "  </head>"
      ].join("\n")
    );
}

function marketingMetaForPath(pathname: string) {
  return MARKETING_SITE_PAGES.find((page) => page.path === pathname) ?? MARKETING_SITE_PAGES[0];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function setLeadWorkflow(
  state: AccountReviewState,
  leadId: string,
  patch: Partial<LeadWorkflow>
) {
  const previous = state.leadWorkflows?.[leadId];
  const workflow: LeadWorkflow = {
    leadId,
    reviewStatus: previous?.reviewStatus ?? "new",
    lifecycleStatus: previous?.lifecycleStatus ?? "not-contacted",
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  (state.leadWorkflows ??= {})[leadId] = workflow;
  return workflow;
}

function coerceReviewStatus(value: unknown): LeadWorkflow["reviewStatus"] | undefined {
  const allowed = new Set<LeadWorkflow["reviewStatus"]>([
    "new", "pending-review", "approved", "rejected", "needs-research", "ready-to-send"
  ]);
  return typeof value === "string" && allowed.has(value as LeadWorkflow["reviewStatus"])
    ? value as LeadWorkflow["reviewStatus"]
    : undefined;
}

function coerceLifecycleStatus(value: unknown): LeadWorkflow["lifecycleStatus"] | undefined {
  const allowed = new Set<LeadWorkflow["lifecycleStatus"]>([
    "not-contacted", "drafted", "personalized", "approved", "sent", "replied",
    "follow-up-due", "closed", "opted-out"
  ]);
  return typeof value === "string" && allowed.has(value as LeadWorkflow["lifecycleStatus"])
    ? value as LeadWorkflow["lifecycleStatus"]
    : undefined;
}

function coerceOutreachJobType(value: unknown): OutreachJob["type"] | undefined {
  return value === "draft-missing" || value === "personalize-all" || value === "lead-search"
    ? value
    : undefined;
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
