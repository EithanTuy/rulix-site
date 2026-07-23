import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { officialCorpus } from "../src/data/corpus";
import { createAuditEvent } from "../src/lib/reviewLifecycle";
import {
  MEMO_CHAT_REQUEST_MAX_BYTES,
  normalizeMemoChatMessage
} from "../src/shared/aiLimits";
import { isReviewId } from "../src/shared/reviewIds";
import type {
  AiApprovalPolicyBinding,
  AiApprovalRequestOfficerDetail,
  AiApprovalRequestRecord,
  AiApprovalRequestStatusKind,
  AiApprovalStatus,
  AiApprovalSubjectBinding,
  AuditEvent,
  CaseComment,
  DataClass,
  MemoBuilderSession,
  MemoChatMessage,
  MemoRecord,
  NewReviewInput,
  OutreachDraft,
  LeadSearchRun,
  LeadWorkflow,
  OutreachJob,
  ReviewResult,
  ReviewerDecision,
  UsageEvent,
  UserProfile,
  WorkspaceNotification
} from "../src/types";
import {
  MARKETING_SITEMAP_PAGES,
  marketingCanonicalPath,
  marketingPageForPath as sharedMarketingPageForPath
} from "../src/marketingPages";
import {
  createLocalPublicMemoTemplate,
  buildCouncilProviderRequest,
  buildMemoBuilderProviderRequest,
  buildMemoChatProviderRequest,
  councilApprovalPayload,
  councilModelForDepth,
  getBedrockRuntime,
  LiveCouncilUnavailableError,
  memoBuilderApprovalPayload,
  memoChatApprovalPayload,
  resolveMemoBuilderProviderLane,
  runCouncilAnalysis,
  runMemoBuildChat,
  runMemoChatWithHaiku,
  type AiEgressCallerContext,
  type CouncilDepth,
  type MemoBuildChatMessage,
  type UsageSample
} from "./bedrockCouncil";
import {
  DocumentValidationError,
  buildDocumentProviderRequest,
  documentExtractionApprovalPayload,
  documentProviderPasses,
  extractDocumentText,
  prepareDocumentExtractionInput
} from "./documentExtraction";
import {
  hashAiApprovalChatHistory,
  hashAiBuilderSession,
  hashAiApprovalPayload,
  sameAiApprovalPolicy,
  sameAiApprovalSubject
} from "./domain/aiApproval";
import { hashMemoContent, hashReviewResult, sha256Canonical } from "./domain/hashes";
import { ReviewPolicyError } from "./domain/reviewPolicy";
import {
  OrganizationAuthorizationError,
  requireOrganizationCapability,
  type OrganizationCapability
} from "./domain/authorization";
import {
  DecisionBindingError,
  StoreError,
  createAccountStore,
  sessionTtlMs,
  type AccountStore,
  type AuthSession,
  type CreateAccessRequestInput,
  type DecisionExpectedBindings,
  type SessionRecord,
  type StoredMemoBuilderSession
} from "./store";
import { isAdminMetricsRangeDays } from "./adminMetricsAggregates";
import { sendInviteEmail, sendPasswordResetEmail } from "./email";
import {
  generateOutreachDraft,
  outreachModel,
  personalizeOutreachDraft,
  personalizationModel
} from "./outreachWriter";
import { discoverLeads, leadSearchModel } from "./leadSearch";
import { outreachDeploymentStatus, outreachProviderReady } from "./aiClient";
import {
  AiEgressPolicyError,
  currentAiApprovalPolicy,
  deploymentDataClass,
  issueTrustedAiWorkflowGrant,
  maxDataClass,
  parseDataClass,
  resolveBedrockLane,
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook,
  type AiTrustedWorkflow,
  type AiProviderClient
} from "./aiEgressGateway";
import { createAiDispatchAdmissionHook } from "./aiAdmission";
import { createStoreAiDispatchAuthorizationHook } from "./aiAuthorization";
import {
  appendOutreachJobLog,
  createOutreachJob,
  estimateJobCost,
  mergeOutreachLeads,
  scheduleOutreachJob
} from "./outreachJobs";
import {
  collectOutreachPages,
  OUTREACH_BULK_ITEM_CAP,
  OUTREACH_BULK_SCAN_CAP,
  OUTREACH_LEAD_SEARCH_INPUT_CAP
} from "./outreachPagination";

const ALLOWED_REVIEW_DEPTHS = new Set<CouncilDepth>(["standard", "deep"]);
const DEVELOPMENT_SESSION_COOKIE = "rulix_session";
const PRODUCTION_SESSION_COOKIE = "__Host-rulix_session";
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://app.rulix.cloud",
  "https://dashboard.rulix.cloud",
  "https://rulix.cloud",
  "https://www.rulix.cloud"
]);
const PUBLIC_SITE_HOSTS = new Set(["rulix.cloud", "www.rulix.cloud"]);
const ACCESS_REQUEST_VOLUMES = new Set([
  "1-5 reviews / month",
  "6-20 reviews / month",
  "21-50 reviews / month",
  "50+ reviews / month"
]);
interface CreateAppOptions {
  store?: AccountStore;
  edgeSharedSecret?: string;
  aiProviderClient?: AiProviderClient;
}

export function createApp(options: CreateAppOptions = {}) {
  const store = options.store ?? createAccountStore();
  setAiDispatchAdmissionHook(createAiDispatchAdmissionHook({ store }));
  setAiDispatchAuthorizationHook(createStoreAiDispatchAuthorizationHook({ store }));
  const edgeSharedSecret = options.edgeSharedSecret ?? process.env.RULIX_EDGE_SHARED_SECRET;
  const aiProviderClient = options.aiProviderClient;
  const app = express();
  const allowedOrigins = allowedCorsOrigins();

  app.disable("x-powered-by");
  app.use(appSecurityHeaders);
  app.use("/api", (_req, res, next) => {
    // Authenticated workspace and token responses must not survive logout in a
    // browser, intermediary, or shared-device cache. CloudFront also uses its
    // managed CachingDisabled policy for this path.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    next();
  });

  if (edgeSharedSecret) {
    app.use((req, res, next) => {
      if (!constantTimeStringEqual(req.get("x-rulix-edge-secret"), edgeSharedSecret)) {
        res.status(403).json({ error: "Requests must arrive through the trusted edge." });
        return;
      }
      next();
    });
  }

  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin");
    const fetchSite = req.get("sec-fetch-site")?.trim().toLowerCase();
    if (
      (origin && !isCorsOriginAllowed(origin, allowedOrigins)) ||
      (!origin && fetchSite === "cross-site")
    ) {
      res.status(403).json({
        code: "untrusted_origin",
        error: "This request did not originate from a trusted Rulix application."
      });
      return;
    }
    next();
  });

  app.use(cors({
    origin: (origin, callback) => {
      callback(null, isCorsOriginAllowed(origin, allowedOrigins));
    },
    credentials: true
  }));
  const parseDefaultJson = jsonParserWithLimit(32 * 1024);
  const parseReviewCreateJson = jsonParserWithLimit(256 * 1024);
  const parseReviewUpdateJson = jsonParserWithLimit(224 * 1024);
  const parseReviewChatJson = jsonParserWithLimit(MEMO_CHAT_REQUEST_MAX_BYTES);
  const parseAiApprovalRequestJson = jsonParserWithLimit(MEMO_CHAT_REQUEST_MAX_BYTES);
  const parseMemoBuilderChatJson = jsonParserWithLimit(256 * 1024);
  const parseBuilderSessionJson = jsonParserWithLimit(320 * 1024);
  const parseDocumentJson = jsonParserWithLimit(12 * 1024 * 1024);
  const parseOutreachDraftJson = jsonParserWithLimit(64 * 1024);
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/documents/extract") {
      parseDocumentJson(req, res, next);
      return;
    }
    if (req.method === "PUT" && req.path.startsWith("/api/account/memo-builder/sessions/")) {
      parseBuilderSessionJson(req, res, next);
      return;
    }
    if (req.method === "PUT" && /^\/api\/admin\/outreach\/drafts\/[^/]+$/.test(req.path)) {
      parseOutreachDraftJson(req, res, next);
      return;
    }
    if (req.method === "POST" && /^\/api\/reviews\/[^/]+\/chat$/.test(req.path)) {
      parseReviewChatJson(req, res, next);
      return;
    }
    if (req.method === "POST" && req.path === "/api/ai-approval-requests") {
      parseAiApprovalRequestJson(req, res, next);
      return;
    }
    if (req.method === "POST" && req.path === "/api/ai/memo-builder-chat") {
      parseMemoBuilderChatJson(req, res, next);
      return;
    }
    if (req.method === "POST" && req.path === "/api/reviews") {
      parseReviewCreateJson(req, res, next);
      return;
    }
    if (req.method === "PATCH" && /^\/api\/reviews\/[^/]+$/.test(req.path)) {
      parseReviewUpdateJson(req, res, next);
      return;
    }
    parseDefaultJson(req, res, next);
  });

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

  app.post("/api/access-requests", async (req, res) => {
    if (normalizeOptional(req.body?.website)) {
      res.status(201).json({
        received: true,
        message: "Thanks. Your request has been received."
      });
      return;
    }

    const parsed = parseAccessRequest(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const accessRequest = await store.createAccessRequest(parsed.input);
      res.status(201).json({
        request: {
          id: accessRequest.id,
          createdAt: accessRequest.createdAt
        },
        message: "Request received. We will reply within one business day."
      });
    } catch (error) {
      if (error instanceof StoreError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "We could not save your request. Please try again." });
    }
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
    if (!bootstrapSecret || !constantTimeStringEqual(req.get("x-rulix-bootstrap-secret"), bootstrapSecret)) {
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
    const raw = Array.isArray(req.query.rangeDays) ? req.query.rangeDays[0] : req.query.rangeDays;
    const rangeDays = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(rangeDays) || !isAdminMetricsRangeDays(rangeDays)) {
      res.status(400).json({
        code: "invalid_metrics_range",
        error: "rangeDays must be one of 7, 30, or 90."
      });
      return;
    }
    try {
      res.json({ metrics: await store.getAdminMetrics(rangeDays) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/admin/users", requireAuth(store), requireAdmin, async (req, res) => {
    const query = coercePageQuery(req, res);
    if (!query) return;
    try {
      const page = await store.listAdminUsersPage(query);
      res.json({ ...page, users: page.items });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/admin/access-requests", requireAuth(store), requireAdmin, async (_req, res) => {
    res.json({ requests: await store.listAccessRequests() });
  });

  app.get("/api/admin/outreach-config", requireAuth(store), requireAdmin, async (_req, res) => {
    const config = await store.getOutreachConfig();
    res.json(outreachDeploymentStatus(config));
  });

  app.put("/api/admin/outreach-config", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    if (
      !isRecord(req.body) ||
      Object.keys(req.body).some((key) => key !== "provider") ||
      (req.body.provider !== "bedrock" && req.body.provider !== "anthropic")
    ) {
      res.status(400).json({
        code: "provider_config_invalid",
        error: "Provider settings accept only a recognized provider; credentials are deployment-managed."
      });
      return;
    }
    const config = { provider: req.body.provider } as const;
    const status = outreachDeploymentStatus(config);
    if (config.provider !== status.deploymentProvider) {
      res.status(409).json({
        code: "provider_policy_mismatch",
        error: `This deployment is approved only for ${status.deploymentProvider}.`
      });
      return;
    }
    if (!status.credentialConfigured || !status.ready) {
      res.status(503).json({
        code: "provider_not_configured",
        error: "The approved provider must be configured through deployment secrets and infrastructure before it can be selected."
      });
      return;
    }
    await store.setOutreachConfig(config);
    res.json(outreachDeploymentStatus(config));
  });

  app.get("/api/admin/outreach", requireAuth(store), requireAdmin, async (req, res) => {
    const query = coerceInitialOutreachPageQuery(req, res);
    if (!query) return;
    try {
      const [leadPage, draftPage, runPage, workflowPage, jobPage, config] = await Promise.all([
        store.listOutreachLeadsPage(res.locals.user.id, query),
        store.listOutreachDraftsPage(res.locals.user.id, query),
        store.listLeadSearchRunsPage(res.locals.user.id, query),
        store.listLeadWorkflowsPage(res.locals.user.id, query),
        store.listOutreachJobsPage(res.locals.user.id, query),
        store.getOutreachConfig()
      ]);
      const leadContexts = await Promise.all(leadPage.items.map(async (lead) => {
        const [draft, workflow] = await Promise.all([
          store.getOutreachDraft(res.locals.user.id, lead.leadId),
          store.getLeadWorkflow(res.locals.user.id, lead.leadId)
        ]);
        return { lead, draft, workflow };
      }));
      const joinedDrafts = [
        ...draftPage.items,
        ...leadContexts.flatMap((row) => row.draft ? [row.draft] : [])
      ];
      const joinedWorkflows = [
        ...workflowPage.items,
        ...leadContexts.flatMap((row) => row.workflow ? [row.workflow] : [])
      ];
      res.json({
        leads: leadPage.items,
        drafts: Object.fromEntries(joinedDrafts.map((draft) => [draft.leadId, draft])),
        leadSearchRuns: runPage.items,
        leadWorkflows: Object.fromEntries(joinedWorkflows.map((workflow) => [workflow.leadId, workflow])),
        outreachJobs: jobPage.items,
        pagination: {
          leads: outreachPageMetadata(leadPage),
          drafts: outreachPageMetadata(draftPage),
          runs: outreachPageMetadata(runPage),
          workflows: outreachPageMetadata(workflowPage),
          jobs: outreachPageMetadata(jobPage)
        },
        bedrock: {
          ready: outreachProviderReady(config),
          provider: config.provider,
          model: outreachModel(),
          personalizationModel: personalizationModel(),
          leadSearchModel: leadSearchModel(),
          region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
        }
      });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/admin/outreach/pages/:collection", requireAuth(store), requireAdmin, async (req, res) => {
    const query = coercePageQuery(req, res);
    if (!query) return;
    try {
      const collection = normalizeText(req.params.collection, "");
      const page = collection === "lead-rows"
        ? await outreachLeadRowsPage(store, res.locals.user.id, query)
        : collection === "leads"
        ? await store.listOutreachLeadsPage(res.locals.user.id, query)
        : collection === "drafts"
          ? await store.listOutreachDraftsPage(res.locals.user.id, query)
          : collection === "runs"
            ? await store.listLeadSearchRunsPage(res.locals.user.id, query)
            : collection === "workflows"
              ? await store.listLeadWorkflowsPage(res.locals.user.id, query)
              : collection === "jobs"
                ? await store.listOutreachJobsPage(res.locals.user.id, query)
                : undefined;
      if (!page) {
        res.status(404).json({ code: "outreach_collection_not_found", error: "Unknown outreach collection." });
        return;
      }
      res.json(page);
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/admin/outreach/generate", requireJsonBytes(16 * 1024), requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const requestId = coerceUuid(req.body?.requestId);
    if (!requestId || !isRecord(req.body) ||
        Object.keys(req.body).some((key) => !["requestId", "leadId", "direction"].includes(key))) {
      res.status(400).json({
        code: "outreach_request_id_required",
        error: "Outreach generation requires only a UUID requestId, leadId, and optional direction."
      });
      return;
    }
    const leadId = normalizeText(req.body?.leadId, "");
    const [lead, existingDraft, existingWorkflow, config] = await Promise.all([
      store.getOutreachLead(res.locals.user.id, leadId),
      store.getOutreachDraft(res.locals.user.id, leadId),
      store.getLeadWorkflow(res.locals.user.id, leadId),
      store.getOutreachConfig()
    ]);
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    const dataClass = deploymentAiDataClass(res);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;
    try {
      const draft = await generateOutreachDraft(
        lead,
        normalizeText(req.body?.direction, ""),
        (sample) => recordUsageSafe(store, res.locals.user, sample),
        config,
        trustedAiEgressContext(res, dataClass, "outreach-writer", lead.leadId, requestId),
        aiProviderClient
      );
      const workflow = buildLeadWorkflow(existingWorkflow, lead.leadId, {
        reviewStatus: "pending-review",
        lifecycleStatus: "drafted"
      });
      await Promise.all([
        store.upsertOutreachDraft(res.locals.user.id, draft, existingDraft?.updatedAt),
        store.upsertLeadWorkflow(res.locals.user.id, workflow, existingWorkflow?.updatedAt)
      ]);
      res.json({ lead, draft });
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      res.status(502).json({ error: error instanceof Error ? error.message : "Bedrock generation failed." });
    }
  });

  app.put("/api/admin/outreach/drafts/:leadId", requireJsonBytes(64 * 1024), requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const routeLeadId = normalizeText(req.params.leadId, "");
    const [lead, previous] = await Promise.all([
      store.getOutreachLead(res.locals.user.id, routeLeadId),
      store.getOutreachDraft(res.locals.user.id, routeLeadId)
    ]);
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    const subject = coerceBoundedString(req.body?.subject, 1, 998);
    const body = coerceBoundedString(req.body?.body, 1, 48_000);
    if (!isRecord(req.body) || Object.keys(req.body).some((key) => !["subject", "body"].includes(key)) ||
        !subject || !body) {
      res.status(400).json({
        code: "invalid_outreach_draft",
        error: "A draft accepts only a 1-998 character subject and a 1-48,000 character body."
      });
      return;
    }
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
    await store.upsertOutreachDraft(res.locals.user.id, draft, previous?.updatedAt);
    res.json({ lead, draft });
  });

  app.post("/api/admin/outreach/drafts/:leadId/mark-sent", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const leadId = normalizeText(req.params.leadId, "");
    const [draft, existingWorkflow] = await Promise.all([
      store.getOutreachDraft(res.locals.user.id, leadId),
      store.getLeadWorkflow(res.locals.user.id, leadId)
    ]);
    if (!draft) {
      res.status(404).json({ error: "Save a draft before marking it sent." });
      return;
    }
    const expectedDraftUpdatedAt = draft.updatedAt;
    draft.sentAt = new Date().toISOString();
    draft.updatedAt = draft.sentAt;
    const workflow = buildLeadWorkflow(existingWorkflow, leadId, {
      reviewStatus: "approved",
      lifecycleStatus: "sent",
      lastContactedAt: draft.sentAt
    });
    await Promise.all([
      store.upsertOutreachDraft(res.locals.user.id, draft, expectedDraftUpdatedAt),
      store.upsertLeadWorkflow(res.locals.user.id, workflow, existingWorkflow?.updatedAt)
    ]);
    res.json({ draft });
  });

  app.post("/api/admin/outreach/drafts/:leadId/personalize", requireJsonBytes(1024), requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const requestId = coerceUuid(req.body?.requestId);
    if (!requestId || !isRecord(req.body) || Object.keys(req.body).some((key) => key !== "requestId")) {
      res.status(400).json({
        code: "outreach_request_id_required",
        error: "Outreach personalization requires only a UUID requestId."
      });
      return;
    }
    const leadId = normalizeText(req.params.leadId, "");
    const [lead, draft, existingWorkflow, config] = await Promise.all([
      store.getOutreachLead(res.locals.user.id, leadId),
      store.getOutreachDraft(res.locals.user.id, leadId),
      store.getLeadWorkflow(res.locals.user.id, leadId),
      store.getOutreachConfig()
    ]);
    if (!lead) {
      res.status(404).json({ error: "Outreach lead not found." });
      return;
    }
    if (!draft) {
      res.status(404).json({ error: "Create a draft before personalizing it." });
      return;
    }
    const dataClass = deploymentAiDataClass(res);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;
    try {
      const personalized = await personalizeOutreachDraft(
        lead,
        draft,
        (sample) => recordUsageSafe(store, res.locals.user, sample),
        config,
        trustedAiEgressContext(res, dataClass, "outreach-personalization", lead.leadId, requestId),
        aiProviderClient
      );
      const workflow = buildLeadWorkflow(existingWorkflow, lead.leadId, {
        reviewStatus: personalized.personalizationStatus === "personalized" ? "pending-review" : "needs-research",
        lifecycleStatus: personalized.personalizationStatus === "personalized" ? "personalized" : "drafted"
      });
      await Promise.all([
        store.upsertOutreachDraft(res.locals.user.id, personalized, draft.updatedAt),
        store.upsertLeadWorkflow(res.locals.user.id, workflow, existingWorkflow?.updatedAt)
      ]);
      res.json({ lead, draft: personalized });
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      if (error instanceof DocumentValidationError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      res.status(502).json({
        error: error instanceof Error ? error.message : "Personalization failed."
      });
    }
  });

  app.put("/api/admin/leads/:leadId/workflow", requireJsonBytes(16 * 1024), requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const leadId = normalizeText(req.params.leadId, "");
    const [lead, existingWorkflow] = await Promise.all([
      store.getOutreachLead(res.locals.user.id, leadId),
      store.getLeadWorkflow(res.locals.user.id, leadId)
    ]);
    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    const reviewStatus = coerceReviewStatus(req.body?.reviewStatus);
    const lifecycleStatus = coerceLifecycleStatus(req.body?.lifecycleStatus);
    const workflowKeys = [
      "reviewStatus", "lifecycleStatus", "assignedOwner", "notes",
      "lastContactedAt", "followUpAt", "replyStatus"
    ];
    const assignedOwner = coerceOptionalBoundedString(req.body?.assignedOwner, 240);
    const notes = coerceOptionalBoundedString(req.body?.notes, 10_000);
    const replyStatus = coerceOptionalBoundedString(req.body?.replyStatus, 240);
    const lastContactedAt = normalizeIsoDate(req.body?.lastContactedAt);
    const followUpAt = normalizeIsoDate(req.body?.followUpAt);
    if (!isRecord(req.body) || Object.keys(req.body).some((key) => !workflowKeys.includes(key)) ||
        !reviewStatus || !lifecycleStatus || assignedOwner === null || notes === null || replyStatus === null ||
        (req.body.lastContactedAt !== undefined && req.body.lastContactedAt !== "" && !lastContactedAt) ||
        (req.body.followUpAt !== undefined && req.body.followUpAt !== "" && !followUpAt)) {
      res.status(400).json({
        code: "invalid_lead_workflow",
        error: "Workflow fields must use recognized statuses, bounded text, and valid ISO timestamps."
      });
      return;
    }
    const workflow = buildLeadWorkflow(existingWorkflow, lead.leadId, {
      reviewStatus,
      lifecycleStatus,
      assignedOwner: assignedOwner ?? undefined,
      notes: notes ?? undefined,
      lastContactedAt,
      followUpAt,
      replyStatus: replyStatus ?? undefined
    });
    await store.upsertLeadWorkflow(res.locals.user.id, workflow, existingWorkflow?.updatedAt);
    res.json({ lead, workflow });
  });

  app.post("/api/admin/outreach/jobs", requireJsonBytes(16 * 1024), requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const type = coerceOutreachJobType(req.body?.type);
    const jobKeys = ["type", "maxCostUsd", "maxRetries", "direction", "searchDurationSeconds"];
    if (!isRecord(req.body) || Object.keys(req.body).some((key) => !jobKeys.includes(key)) || !type) {
      res.status(400).json({ error: "Unknown outreach job type." });
      return;
    }
    try {
      let itemIds: string[] = [];
      if (type !== "lead-search") {
        const [leads, draftValues] = await Promise.all([
          collectOutreachPages({
            readPage: (query) => store.listOutreachLeadsPage(res.locals.user.id, query),
            maximum: OUTREACH_BULK_SCAN_CAP,
            collection: "outreach leads"
          }),
          collectOutreachPages({
            readPage: (query) => store.listOutreachDraftsPage(res.locals.user.id, query),
            maximum: OUTREACH_BULK_SCAN_CAP,
            collection: "outreach drafts"
          })
        ]);
        const drafts = Object.fromEntries(draftValues.map((draft) => [draft.leadId, draft]));
        itemIds = type === "draft-missing"
          ? leads.filter((lead) => !drafts[lead.leadId]).map((lead) => lead.leadId)
          : leads.filter((lead) => Boolean(drafts[lead.leadId] && !drafts[lead.leadId]!.sentAt))
            .map((lead) => lead.leadId);
        if (itemIds.length > OUTREACH_BULK_ITEM_CAP) {
          throw new StoreError(
            422,
            `This job has ${itemIds.length} eligible items; the explicit per-job cap is ${OUTREACH_BULK_ITEM_CAP}. Narrow the pipeline before queueing it.`,
            "outreach_bulk_limit_exceeded"
          );
        }
      }
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
        appendOutreachJobLog(job, {
          at: job.completedAt,
          message: "No eligible items were found.",
          level: "success"
        });
      }
      await store.upsertOutreachJob(res.locals.user.id, job);
      if (job.status === "queued") {
        await scheduleOutreachJob({
          source: "rulix.outreach-worker",
          userId: res.locals.user.id,
          userEmail: res.locals.user.email,
          jobId: job.id
        }, 0, store);
      }
      res.status(202).json({ job });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/admin/outreach/jobs/:jobId/:action", requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const action = normalizeText(req.params.action, "");
    if (!["pause", "resume", "retry", "terminate"].includes(action)) {
      res.status(400).json({ error: "Unknown job action." });
      return;
    }
    const jobId = normalizeText(req.params.jobId, "");
    const job = await store.getOutreachJob(res.locals.user.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Outreach job not found." });
      return;
    }
    const expectedJobUpdatedAt = job.updatedAt;
    if (action === "terminate") {
      if (job.status !== "completed" && job.status !== "terminated") {
        const now = new Date().toISOString();
        job.status = "terminated";
        job.completedAt = now;
        job.error = undefined;
        appendOutreachJobLog(job, {
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
      appendOutreachJobLog(job, { at: new Date().toISOString(), message: "Paused by operator.", level: "warning" });
    } else {
      job.status = "queued";
      job.error = undefined;
      if (action === "retry") job.retryCount = 0;
      appendOutreachJobLog(job, {
        at: new Date().toISOString(),
        message: `${action === "retry" ? "Retry" : "Resume"} requested by operator.`,
        level: "info"
      });
    }
    job.updatedAt = new Date().toISOString();
    await store.upsertOutreachJob(res.locals.user.id, job, expectedJobUpdatedAt);
    if (job.status === "queued") {
      await scheduleOutreachJob({
        source: "rulix.outreach-worker",
        userId: res.locals.user.id,
        userEmail: res.locals.user.email,
        jobId: job.id
      }, 0, store);
    }
    res.json({ job });
  });

  app.post("/api/admin/leads/search", requireJsonBytes(1024), requireAuth(store), requireCsrf, requireAdmin, async (req, res) => {
    const requestId = coerceUuid(req.body?.requestId);
    if (!requestId || !isRecord(req.body) ||
        Object.keys(req.body).some((key) => key !== "requestId" && key !== "durationSeconds")) {
      res.status(400).json({
        code: "lead_search_request_id_required",
        error: "Lead search requires only a UUID requestId and bounded durationSeconds."
      });
      return;
    }
    const durationSeconds = clampNumber(Number(req.body?.durationSeconds) || 30, 15, 45);
    const startedAt = new Date().toISOString();
    let storedLeads;
    let config;
    try {
      [storedLeads, config] = await Promise.all([
        collectOutreachPages({
          readPage: (query) => store.listOutreachLeadsPage(res.locals.user.id, query),
          maximum: OUTREACH_LEAD_SEARCH_INPUT_CAP,
          collection: "lead-search exclusion list"
        }),
        store.getOutreachConfig()
      ]);
    } catch (error) {
      sendStoreError(res, error);
      return;
    }
    const existingLeads = mergeOutreachLeads(storedLeads);
    const dataClass = deploymentAiDataClass(res);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;
    try {
      const result = await discoverLeads({
        existingLeads,
        durationSeconds,
        onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample),
        egress: trustedAiEgressContext(
          res,
          dataClass,
          "lead-search",
          "synchronous-lead-search",
          requestId
        ),
        providerClient: aiProviderClient,
        config
      });
      const combinedLeads = mergeOutreachLeads([...storedLeads, ...result.leads]);
      const run: LeadSearchRun = {
        id: `lead-search-${startedAt.replace(/[^0-9]/g, "")}-${randomUUID()}`,
        startedAt,
        completedAt: new Date().toISOString(),
        durationSeconds,
        model: result.model,
        status: "completed",
        addedLeadIds: result.leads.map((lead) => lead.leadId),
        activity: result.activity
      };
      await Promise.all([
        store.upsertOutreachLeads(res.locals.user.id, result.leads),
        store.appendLeadSearchRun(res.locals.user.id, run)
      ]);
      res.json({ leads: combinedLeads, run });
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      const run: LeadSearchRun = {
        id: `lead-search-${startedAt.replace(/[^0-9]/g, "")}-${randomUUID()}`,
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
      await store.appendLeadSearchRun(res.locals.user.id, run);
      res.status(502).json({ error: run.error, run });
    }
  });

  app.post("/api/auth/invite/inspect", requireJsonBytes(1024), async (req, res) => {
    const token = coerceAuthToken(req.body?.token);
    if (!token) {
      res.status(400).json({ code: "invalid_auth_token", error: "Invite token is invalid." });
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ invite: await store.getInviteByToken(token) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/invite/accept", requireJsonBytes(16 * 1024), async (req, res) => {
    const token = coerceAuthToken(req.body?.token);
    if (!token) {
      res.status(400).json({ code: "invalid_auth_token", error: "Invite token is invalid." });
      return;
    }
    try {
      const session = await store.acceptInvite(
        token,
        rawString(req.body?.password),
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
        rawString(req.body?.password)
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

  app.post("/api/auth/password-reset/inspect", requireJsonBytes(1024), async (req, res) => {
    const token = coerceAuthToken(req.body?.token);
    if (!token) {
      res.status(400).json({ code: "invalid_auth_token", error: "Password-reset token is invalid." });
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ reset: await store.getPasswordResetByToken(token) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/auth/password-reset/complete", requireJsonBytes(16 * 1024), async (req, res) => {
    const token = coerceAuthToken(req.body?.token);
    if (!token) {
      res.status(400).json({ code: "invalid_auth_token", error: "Password-reset token is invalid." });
      return;
    }
    try {
      const session = await store.completePasswordReset(
        token,
        rawString(req.body?.password)
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
    res.status(410).json({
      code: "client_upgrade_required",
      error: "Refresh Rulix to use the paged workspace API."
    });
  });

  app.put("/api/account/state", requireAuth(store), requireCsrf, async (req, res) => {
    void req;
    res.status(410).json({
      code: "client_upgrade_required",
      error: "Review records, analysis, decisions, and audit history are server-owned. Refresh Rulix to use the current command API."
    });
  });

  app.get("/api/account/preferences", requireAuth(store), async (_req, res) => {
    res.json(await store.getWorkspacePreferences(res.locals.user.id));
  });

  app.get("/api/tenant/members", requireAuth(store), async (_req, res) => {
    const users = await store.listUsers();
    res.json({
      items: users.map(({ id, name, email, role }) => ({ id, name, email, role }))
    });
  });

  app.patch("/api/account/preferences", requireJsonBytes(16 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const command = coerceWorkspacePreferenceCommand(req.body);
    if (!command) {
      res.status(400).json({ code: "invalid_preferences", error: "Preferences require a version and only bounded workspace, route, guidance, view, or selection fields." });
      return;
    }
    try {
      res.json(await store.updateWorkspacePreferences(res.locals.user.id, command));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/account/memo-builder/sessions", requireAuth(store), async (req, res) => {
    const query = coercePageQuery(req, res);
    if (!query) return;
    try {
      res.json(await store.listMemoBuilderSessions(res.locals.user.id, query));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.put("/api/account/memo-builder/sessions/:sessionId", requireJsonBytes(320 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const sessionId = coercePathId(req.params.sessionId, "builder-", 128);
    const expectedVersion = coerceExpectedVersion(req.body?.expectedVersion, true);
    const session = coerceMemoBuilderSession(req.body?.session, sessionId);
    if (!sessionId || expectedVersion === undefined || !session) {
      res.status(400).json({ code: "invalid_builder_session", error: "A bounded builder session and expected version are required." });
      return;
    }
    try {
      res.json(await store.upsertMemoBuilderSession(res.locals.user.id, sessionId, { expectedVersion, session }));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.delete("/api/account/memo-builder/sessions/:sessionId", requireJsonBytes(4 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const sessionId = coercePathId(req.params.sessionId, "builder-", 128);
    const expectedVersion = coerceExpectedVersion(req.body?.expectedVersion, false);
    if (!sessionId || expectedVersion === undefined) {
      res.status(400).json({ code: "invalid_builder_session", error: "A builder session ID and expected version are required." });
      return;
    }
    try {
      await store.deleteMemoBuilderSession(res.locals.user.id, sessionId, expectedVersion);
      res.status(204).end();
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/reviews", requireAuth(store), async (req, res) => {
    const query = coerceReviewPageQuery(req, res);
    if (!query) return;
    try {
      res.json(await store.listReviews(res.locals.user.id, query));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post("/api/reviews", requireJsonBytes(256 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const input = coerceNewReviewInput(req.body);
    const requestId = coerceUuid(req.body?.requestId);
    if (!input || !requestId) {
      res.status(400).json({ code: "invalid_review", error: "A UUID requestId and non-empty bounded memo are required." });
      return;
    }
    const dataClass = input.dataClass;
    if (!enforceDataClass(res, dataClass)) return;
    const memo = createMemoRecord({ ...input, dataClass }, res.locals.user);
    const inputHash = sha256Canonical({ ...input, dataClass });
    const auditEvent = authoritativeReviewAuditEvent(
      res.locals.user,
      memo.id,
      "Review created",
      "Review was created through the authenticated Rulix API.",
      memo.dataClass === "itar-risk" || memo.dataClass === "cui" ? "escalate" : "info"
    );
    try {
      const result = await store.createReviewIdempotent(res.locals.user.id, {
        requestId,
        inputHash,
        memo,
        auditEvent
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/reviews/:id", requireAuth(store), async (req, res) => {
    const memoId = coerceReviewId(req, res);
    if (!memoId) return;
    const detail = await store.getReviewDetail(res.locals.user.id, memoId);
    if (!detail) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    res.json(detail);
  });

  app.get("/api/reviews/:id/audit", requireAuth(store), async (req, res) => {
    const memoId = coerceReviewId(req, res);
    const query = coercePageQuery(req, res);
    if (!memoId || !query) return;
    try {
      res.json(await store.listReviewAuditEvents(res.locals.user.id, memoId, query));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get("/api/reviews/:id/chat", requireAuth(store), async (req, res) => {
    const memoId = coerceReviewId(req, res);
    const query = coercePageQuery(req, res);
    if (!memoId || !query) return;
    try {
      res.json(await store.listReviewChatMessages(res.locals.user.id, memoId, query));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.patch(
    "/api/reviews/:id/metadata",
    requireJsonBytes(16 * 1024),
    requireAuth(store),
    requireCsrf,
    requireRoles("reviewer", "counsel", "export-control-officer"),
    async (req, res) => {
      const memoId = coerceReviewId(req, res);
      const command = coerceReviewMetadataCommand(req.body);
      if (!memoId || !command) {
        if (memoId) res.status(400).json({
          code: "invalid_review_metadata",
          error: "Metadata updates require current review bindings and at least one bounded field."
        });
        return;
      }
      const changedFields = [...Object.keys(command.patch), ...command.clear];
      const auditEvent = authoritativeReviewAuditEvent(
        res.locals.user,
        memoId,
        "Review metadata updated",
        `Updated ${changedFields.join(", ")}.`,
        changedFields.includes("lifecycleStage") || changedFields.includes("dueAt") ? "review" : "info",
        { changedFields: changedFields.join(",") }
      );
      try {
        const result = await store.updateReviewMetadata(res.locals.user.id, memoId, {
          ...command,
          auditEvent
        });
        const users = await store.listUsers();
        const recipients = new Map(users.map((user) => [user.id, user]));
        const notifications: Array<{ userId: string; notification: WorkspaceNotification }> = [];
        if (command.patch.assignedTo) {
          const assignee = recipients.get(command.patch.assignedTo);
          if (assignee) notifications.push({
            userId: assignee.id,
            notification: workspaceNotification(assignee.id, memoId, "assignment", "Review assigned", `${result.review.title} was assigned to you.`)
          });
        }
        if (command.patch.dueAt && result.review.assignedTo) {
          const assignee = recipients.get(result.review.assignedTo);
          if (assignee) notifications.push({
            userId: assignee.id,
            notification: workspaceNotification(assignee.id, memoId, "due-date", "Review due date changed", `${result.review.title} is due ${command.patch.dueAt.slice(0, 10)}.`)
          });
        }
        await Promise.all(notifications.map(({ userId, notification }) =>
          store.appendNotifications(userId, [notification])));
        res.json(result);
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.get("/api/reviews/:id/comments", requireAuth(store), async (req, res) => {
    const memoId = coerceReviewId(req, res);
    const query = coercePageQuery(req, res);
    if (!memoId || !query) return;
    try {
      res.json(await store.listReviewComments(res.locals.user.id, memoId, query));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post(
    "/api/reviews/:id/comments",
    requireJsonBytes(8 * 1024),
    requireAuth(store),
    requireCsrf,
    async (req, res) => {
      const memoId = coerceReviewId(req, res);
      const input = coerceCommentInput(req.body);
      if (!memoId || !input) {
        if (memoId) res.status(400).json({ code: "invalid_comment", error: "A bounded comment and tenant-member mentions are required." });
        return;
      }
      try {
        const users = await store.listUsers();
        const byId = new Map(users.map((user) => [user.id, user]));
        if (input.mentions.some((userId) => !byId.has(userId))) {
          res.status(400).json({ code: "invalid_mention", error: "Comments may mention only current tenant members." });
          return;
        }
        const now = new Date().toISOString();
        const comment: CaseComment = {
          id: `comment-${randomUUID()}`,
          memoId,
          authorId: res.locals.user.id,
          authorName: res.locals.user.name,
          body: input.body,
          createdAt: now,
          mentions: input.mentions
        };
        const requestInformation = input.kind === "request-information";
        const auditEvent = authoritativeReviewAuditEvent(
          res.locals.user,
          memoId,
          requestInformation ? "Information requested" : "Comment added",
          requestInformation ? "A tenant-visible request for information was added." : "A tenant-visible review comment was added.",
          requestInformation ? "review" : "info",
          { commentId: comment.id }
        );
        const created = await store.createReviewComment(res.locals.user.id, memoId, { comment, auditEvent });
        await Promise.all(input.mentions
          .filter((userId) => userId !== res.locals.user.id)
          .map((userId) => store.appendNotifications(userId, [workspaceNotification(
            userId,
            memoId,
            requestInformation ? "request-info" : "mention",
            requestInformation ? "Information requested" : `${res.locals.user.name} mentioned you`,
            input.body
          )])));
        res.status(201).json(created);
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/reviews/:id/comments/:commentId/resolve",
    requireJsonBytes(2 * 1024),
    requireAuth(store),
    requireCsrf,
    async (req, res) => {
      const memoId = coerceReviewId(req, res);
      const commentId = coercePathId(req.params.commentId, "comment-", 128);
      if (!memoId || !commentId || Object.keys(req.body ?? {}).length > 0) {
        if (memoId) res.status(400).json({ code: "invalid_comment_resolution", error: "Comment resolution accepts no request fields." });
        return;
      }
      try {
        const comment = await findReviewComment(store, res.locals.user.id, memoId, commentId);
        if (!comment) {
          res.status(404).json({ code: "comment_not_found", error: "Comment not found." });
          return;
        }
        if (comment.authorId !== res.locals.user.id && res.locals.user.role !== "export-control-officer") {
          res.status(403).json({ code: "comment_resolution_forbidden", error: "Only the comment author or an export-control officer can resolve it." });
          return;
        }
        const resolvedAt = new Date().toISOString();
        const auditEvent = authoritativeReviewAuditEvent(
          res.locals.user,
          memoId,
          "Comment resolved",
          "A tenant-visible review comment was resolved.",
          "info",
          { commentId }
        );
        res.json(await store.resolveReviewComment(res.locals.user.id, memoId, commentId, {
          resolvedAt,
          resolvedBy: res.locals.user.id,
          auditEvent
        }));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.get("/api/notifications", requireAuth(store), async (req, res) => {
    const query = coerceNotificationPageQuery(req, res);
    if (!query) return;
    try {
      res.json(await store.listNotifications(res.locals.user.id, query));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.patch("/api/notifications/read", requireJsonBytes(2 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    if (Object.keys(req.body ?? {}).length > 0) {
      res.status(400).json({ code: "invalid_notification_patch", error: "Mark-all-read accepts no request fields." });
      return;
    }
    try {
      const readAt = new Date().toISOString();
      const count = await store.markAllNotificationsRead(res.locals.user.id, readAt);
      res.json({ count, readAt });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.patch("/api/notifications/:notificationId/read", requireJsonBytes(2 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const notificationId = coercePathId(req.params.notificationId, "notification-", 128);
    if (!notificationId || Object.keys(req.body ?? {}).length > 0) {
      res.status(400).json({ code: "invalid_notification_patch", error: "A valid notification ID is required." });
      return;
    }
    try {
      const notification = await store.markNotificationRead(res.locals.user.id, notificationId, new Date().toISOString());
      if (!notification) {
        res.status(404).json({ code: "notification_not_found", error: "Notification not found." });
        return;
      }
      res.json(notification);
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.patch("/api/reviews/:id", requireJsonBytes(224 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const memoId = coerceReviewId(req, res);
    if (!memoId) return;
    const keys = Object.keys(req.body ?? {});
    const bindings = coerceReviewBindings(req.body);
    const hasMemoText = Object.prototype.hasOwnProperty.call(req.body ?? {}, "memoText");
    const hasArchived = Object.prototype.hasOwnProperty.call(req.body ?? {}, "archived");
    const allowed = new Set(["expectedVersion", "expectedRevision", "expectedHash", hasMemoText ? "memoText" : "archived"]);
    if (!bindings || hasMemoText === hasArchived || keys.some((key) => !allowed.has(key))) {
      res.status(400).json({ code: "invalid_review_patch", error: "Patch exactly one of memoText or archived with current review bindings." });
      return;
    }
    const memoText = hasMemoText ? coerceBoundedString(req.body.memoText, 1, 200_000) : undefined;
    if (hasMemoText && !memoText) {
      res.status(400).json({ code: "memo_text_required", error: "memoText is required." });
      return;
    }
    if (hasArchived && typeof req.body.archived !== "boolean") {
      res.status(400).json({ code: "archive_value_required", error: "archived must be a boolean." });
      return;
    }
    try {
      const auditEvent = authoritativeReviewAuditEvent(
        res.locals.user,
        memoId,
        hasMemoText ? "Memo edited" : req.body.archived ? "Memo archived" : "Memo unarchived",
        hasMemoText
          ? "Memo text changed through the authenticated Rulix API."
          : req.body.archived
            ? "Memo was removed from the active queue and retained in history."
            : "Memo was returned to the active review queue.",
        "review"
      );
      const result = hasMemoText
        ? await store.updateReviewMemo(res.locals.user.id, memoId, {
            ...bindings,
            memoText: memoText!,
            auditEvent
          })
        : await store.setReviewArchived(res.locals.user.id, memoId, {
            ...bindings,
            archived: req.body.archived === true,
            actor: res.locals.user.name,
            auditEvent
          });
      res.json(result);
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.get(
    "/api/ai-approval-requests",
    requireAuth(store),
    async (req, res) => {
      const query = coerceAiApprovalRequestPageQuery(req, res);
      if (!query) return;
      try {
        res.json(await store.listAiApprovalRequests(res.locals.user.id, query));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.get(
    "/api/ai-approval-requests/:requestId",
    requireAuth(store),
    async (req, res) => {
      const approvalRequestId = coercePathId(req.params.requestId, "air-", 128);
      if (!approvalRequestId) {
        res.status(400).json({ code: "invalid_ai_approval_request_id", error: "AI approval request ID is invalid." });
        return;
      }
      try {
        const status = await store.getAiApprovalRequest(res.locals.user.id, approvalRequestId);
        if (!status) {
          res.status(404).json({ code: "ai_approval_request_not_found", error: "AI approval request not found." });
          return;
        }
        res.json(status);
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/ai-approval-requests",
    requireJsonBytes(MEMO_CHAT_REQUEST_MAX_BYTES),
    requireAuth(store),
    requireCsrf,
    async (req, res) => {
      const requestId = coerceUuid(req.body?.requestId);
      const purpose = req.body?.purpose;
      if (!isRecord(req.body) || !requestId ||
          (purpose !== "council" && purpose !== "memo-chat" && purpose !== "memo-builder")) {
        res.status(400).json({
          code: "invalid_ai_approval_request",
          error: "AI approval requests require a UUID requestId and one supported purpose."
        });
        return;
      }
      try {
        if (purpose === "memo-builder") {
          const allowed = new Set(["requestId", "purpose", "sessionId"]);
          const sessionId = coercePathId(req.body.sessionId, "builder-", 128);
          if (!sessionId || Object.keys(req.body).some((key) => !allowed.has(key))) {
            res.status(400).json({
              code: "invalid_ai_approval_request",
              error: "Memo Builder approval requests accept only requestId, purpose, and a saved sessionId."
            });
            return;
          }
          const stored = await findMemoBuilderSession(store, res.locals.user.id, sessionId);
          const pendingMessage = coerceBoundedString(stored?.session.pendingInput, 1, 8_000);
          if (!stored || !pendingMessage) {
            res.status(409).json({
              code: "memo_builder_pending_input_required",
              error: "Save the exact pending Memo Builder message before requesting approval."
            });
            return;
          }
          if (stored.session.messages.length >= 20) {
            res.status(409).json({
              code: "memo_builder_session_full",
              error: "This Memo Builder session reached its 20-message limit. Start a new chat to continue."
            });
            return;
          }
          const dataClass = storedAiDataClass(res, stored.session.dataClass);
          if (!dataClass || !enforceDataClass(res, dataClass)) return;
          const messages: MemoBuildChatMessage[] = [
            ...stored.session.messages,
            { role: "user", content: pendingMessage }
          ];
          const expected = memoBuilderApprovalExpectation(stored, messages, dataClass);
          const status = await store.createAiApprovalRequest(res.locals.user.id, {
            requestId,
            requestedBy: { id: res.locals.user.id, role: res.locals.user.role },
            purpose,
            ...expected,
            dataClass,
            context: { kind: "memo-builder" }
          });
          res.status(201).json(status);
          return;
        }

        const allowed = purpose === "council"
          ? new Set(["requestId", "purpose", "reviewId", "depth", "expectedVersion", "expectedRevision", "expectedHash"])
          : new Set(["requestId", "purpose", "reviewId", "message", "expectedVersion", "expectedRevision", "expectedHash"]);
        const reviewId = coerceReviewEntityId(req.body.reviewId);
        const bindings = coerceReviewBindings(req.body);
        if (!reviewId || !bindings || Object.keys(req.body).some((key) => !allowed.has(key))) {
          res.status(400).json({
            code: "invalid_ai_approval_request",
            error: "Review approval requests require only the exact current review bindings and purpose-specific input."
          });
          return;
        }
        if (res.locals.user.role === "submitter") {
          res.status(403).json({
            code: "reviewer_role_required",
            error: "Reviewer, counsel, or export-control officer access is required for review AI requests."
          });
          return;
        }
        const detail = await store.getReviewDetail(res.locals.user.id, reviewId);
        const memo = detail?.review;
        if (!memo) {
          res.status(404).json({ error: "Review not found." });
          return;
        }
        if (!reviewMatchesBindings(memo, bindings)) {
          res.status(409).json({
            code: "stale_revision",
            error: "The review changed before the approval request was recorded. Reload and try again."
          });
          return;
        }
        const dataClass = storedAiDataClass(res, memo.dataClass);
        if (!dataClass || !enforceDataClass(res, dataClass)) return;

        if (purpose === "council") {
          const depth = coerceReviewDepth(req.body.depth);
          const expected = councilApprovalExpectation(memo, depth, dataClass);
          const status = await store.createAiApprovalRequest(res.locals.user.id, {
            requestId,
            requestedBy: { id: res.locals.user.id, role: res.locals.user.role },
            purpose,
            ...expected,
            dataClass,
            context: { kind: "council", depth }
          });
          res.status(201).json(status);
          return;
        }

        const message = normalizeMemoChatMessage(req.body.message);
        if (!message) {
          res.status(400).json({ code: "chat_message_required", error: "One bounded chat message is required." });
          return;
        }
        const history = await loadAiApprovalChatHistory(store, res.locals.user.id, memo.id);
        const expected = memoChatApprovalExpectation(memo, message, history, dataClass);
        const status = await store.createAiApprovalRequest(res.locals.user.id, {
          requestId,
          requestedBy: { id: res.locals.user.id, role: res.locals.user.role },
          purpose,
          ...expected,
          dataClass,
          context: {
            kind: "memo-chat",
            pendingMessageHash: hashAiApprovalPayload(message),
            historyHash: hashAiApprovalChatHistory(history)
          },
          pendingContent: { kind: "memo-chat", text: message }
        });
        res.status(201).json(status);
      } catch (error) {
        if (sendAiEgressError(res, error)) return;
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/ai-approval-requests/:requestId/cancel",
    requireJsonBytes(2 * 1024),
    requireAuth(store),
    requireCsrf,
    async (req, res) => {
      const approvalRequestId = coercePathId(req.params.requestId, "air-", 128);
      const commandRequestId = coerceUuid(req.body?.requestId);
      const reason = coerceBoundedString(req.body?.reason, 1, 500);
      if (!approvalRequestId || !commandRequestId || !reason || !isRecord(req.body) ||
          Object.keys(req.body).some((key) => key !== "requestId" && key !== "reason")) {
        res.status(400).json({
          code: "invalid_ai_approval_request_cancellation",
          error: "Cancellation requires a request ID, UUID command requestId, and bounded reason."
        });
        return;
      }
      try {
        res.json(await store.cancelAiApprovalRequest(res.locals.user.id, approvalRequestId, {
          requestId: commandRequestId,
          actor: { id: res.locals.user.id, role: res.locals.user.role },
          reason
        }));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.get(
    "/api/admin/ai-approval-requests",
    requireAuth(store),
    requireAdmin,
    async (req, res) => {
      const query = coerceAiApprovalRequestPageQuery(req, res);
      if (!query) return;
      try {
        res.json(await store.listTenantAiApprovalRequests(
          { id: res.locals.user.id, role: res.locals.user.role },
          query
        ));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.get(
    "/api/admin/ai-approval-requests/:requestId",
    requireAuth(store),
    requireAdmin,
    async (req, res) => {
      const approvalRequestId = coercePathId(req.params.requestId, "air-", 128);
      if (!approvalRequestId) {
        res.status(400).json({ code: "invalid_ai_approval_request_id", error: "AI approval request ID is invalid." });
        return;
      }
      try {
        const status = await store.getTenantAiApprovalRequest(
          { id: res.locals.user.id, role: res.locals.user.role },
          approvalRequestId
        );
        if (!status) {
          res.status(404).json({ code: "ai_approval_request_not_found", error: "AI approval request not found." });
          return;
        }
        res.json(await buildAiApprovalOfficerDetail(store, status));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/admin/ai-approval-requests/:requestId/approve",
    requireJsonBytes(1024),
    requireAuth(store),
    requireCsrf,
    requireAdmin,
    async (req, res) => {
      const approvalRequestId = coercePathId(req.params.requestId, "air-", 128);
      const requestId = coerceUuid(req.body?.requestId);
      if (!approvalRequestId || !requestId || !isRecord(req.body) ||
          Object.keys(req.body).some((key) => key !== "requestId")) {
        res.status(400).json({
          code: "invalid_ai_approval_decision",
          error: "Approval accepts only a UUID requestId; all authorization bindings come from the immutable request."
        });
        return;
      }
      try {
        const detail = await store.getTenantAiApprovalRequest(
          { id: res.locals.user.id, role: res.locals.user.role },
          approvalRequestId
        );
        if (!detail) {
          res.status(404).json({ code: "ai_approval_request_not_found", error: "AI approval request not found." });
          return;
        }
        const inspected = await buildAiApprovalOfficerDetail(store, detail);
        if (!inspected.inspection.current) {
          res.status(409).json({
            code: "ai_approval_request_stale",
            error: inspected.inspection.unavailableReason ??
              "The target content, classification, provider policy, or exact request body changed. Create a new request."
          });
          return;
        }
        res.json(await store.approveAiApprovalRequest(approvalRequestId, {
          requestId,
          decidedBy: { id: res.locals.user.id, role: res.locals.user.role }
        }));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/admin/ai-approval-requests/:requestId/reject",
    requireJsonBytes(2 * 1024),
    requireAuth(store),
    requireCsrf,
    requireAdmin,
    async (req, res) => {
      const approvalRequestId = coercePathId(req.params.requestId, "air-", 128);
      const requestId = coerceUuid(req.body?.requestId);
      const reason = coerceBoundedString(req.body?.reason, 1, 500);
      if (!approvalRequestId || !requestId || !reason || !isRecord(req.body) ||
          Object.keys(req.body).some((key) => key !== "requestId" && key !== "reason")) {
        res.status(400).json({
          code: "invalid_ai_approval_decision",
          error: "Rejection requires only a UUID requestId and bounded reason."
        });
        return;
      }
      try {
        res.json(await store.rejectAiApprovalRequest(approvalRequestId, {
          requestId,
          decidedBy: { id: res.locals.user.id, role: res.locals.user.role },
          reason
        }));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/admin/ai-approval-requests/:requestId/revoke",
    requireJsonBytes(2 * 1024),
    requireAuth(store),
    requireCsrf,
    requireAdmin,
    async (req, res) => {
      const approvalRequestId = coercePathId(req.params.requestId, "air-", 128);
      const requestId = coerceUuid(req.body?.requestId);
      const reason = coerceBoundedString(req.body?.reason, 1, 500);
      if (!approvalRequestId || !requestId || !reason || !isRecord(req.body) ||
          Object.keys(req.body).some((key) => key !== "requestId" && key !== "reason")) {
        res.status(400).json({
          code: "invalid_ai_approval_revocation",
          error: "Queued approval revocation requires only a UUID requestId and bounded reason."
        });
        return;
      }
      try {
        res.json(await store.revokeAiApprovalRequestApproval(approvalRequestId, {
          requestId,
          revokedBy: { id: res.locals.user.id, role: res.locals.user.role },
          reason
        }));
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.get(
    "/api/reviews/:id/ai-approvals/council",
    requireAuth(store),
    requireRoles("export-control-officer", "reviewer", "counsel"),
    async (req, res) => {
      const memoId = coerceReviewId(req, res);
      if (!memoId) return;
      const detail = await store.getReviewDetail(res.locals.user.id, memoId);
      const memo = detail?.review;
      if (!memo) {
        res.status(404).json({ error: "Review not found." });
        return;
      }
      const dataClass = storedAiDataClass(res, memo.dataClass);
      if (!dataClass || !enforceDataClass(res, dataClass)) return;
      const depth = coerceReviewDepth(req.query.depth);
      try {
        const expected = councilApprovalExpectation(memo, depth, dataClass);
        const approval = await store.getCurrentAiApproval(res.locals.user.id, {
          purpose: "council",
          subjectKind: "review",
          subjectId: memo.id
        });
        res.json({
          purpose: "council",
          depth,
          subject: expected.subject,
          payloadHash: expected.payloadHash,
          policy: expected.policy,
          approval,
          usable: isApprovalUsable(approval, expected, dataClass)
        });
      } catch (error) {
        if (sendAiEgressError(res, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/reviews/:id/ai-approvals/council",
    requireJsonBytes(4 * 1024),
    requireAuth(store),
    requireCsrf,
    requireAdmin,
    async (req, res) => {
      const memoId = coerceReviewId(req, res);
      const bindings = coerceReviewBindings(req.body);
      const requestId = coerceUuid(req.body?.requestId);
      const allowed = new Set([
        "requestId", "depth", "expectedVersion", "expectedRevision", "expectedHash"
      ]);
      if (!memoId || !bindings || !requestId || !isRecord(req.body) ||
          Object.keys(req.body).some((key) => !allowed.has(key))) {
        res.status(400).json({
          code: "ai_approval_binding_required",
          error: "Approval requires only a UUID requestId, analysis depth, and the current review bindings."
        });
        return;
      }
      const detail = await store.getReviewDetail(res.locals.user.id, memoId);
      const memo = detail?.review;
      if (!memo) {
        res.status(404).json({ error: "Review not found." });
        return;
      }
      if (!reviewMatchesBindings(memo, bindings)) {
        res.status(409).json({
          code: "stale_revision",
          error: "The review changed before approval. Reload the exact revision before approving AI use."
        });
        return;
      }
      const dataClass = storedAiDataClass(res, memo.dataClass);
      if (!dataClass || !enforceDataClass(res, dataClass)) return;
      const depth = coerceReviewDepth(req.body.depth);
      try {
        const expected = councilApprovalExpectation(memo, depth, dataClass);
        const approval = await store.createAiApproval(res.locals.user.id, {
          requestId,
          purpose: "council",
          subject: expected.subject,
          payloadHash: expected.payloadHash,
          providerRequestHashes: expected.providerRequestHashes,
          dataClass,
          policy: expected.policy,
          approvedBy: {
            id: res.locals.user.id,
            role: res.locals.user.role
          },
          dispatchLimit: 1
        });
        res.status(201).json({
          approval: {
            approval,
            current: true,
            dispatchesReserved: 0
          } satisfies AiApprovalStatus,
          usable: true
        });
      } catch (error) {
        if (sendAiEgressError(res, error)) return;
        if (error instanceof StoreError) {
          sendStoreError(res, error);
          return;
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/ai-approvals/:approvalId/revoke",
    requireJsonBytes(2 * 1024),
    requireAuth(store),
    requireCsrf,
    requireAdmin,
    async (req, res) => {
      const approvalId = coercePathId(req.params.approvalId, "aia-", 160);
      const reason = coerceBoundedString(req.body?.reason, 1, 500);
      const requestId = coerceUuid(req.body?.requestId);
      if (!approvalId || !reason || !requestId || !isRecord(req.body) ||
          Object.keys(req.body).some((key) => key !== "reason" && key !== "requestId")) {
        res.status(400).json({
          code: "ai_approval_revocation_invalid",
          error: "Revocation requires one bounded reason."
        });
        return;
      }
      try {
        const status = await store.revokeAiApproval(res.locals.user.id, approvalId, {
          requestId,
          revokedBy: { id: res.locals.user.id, role: res.locals.user.role },
          reason
        });
        res.json({ approval: status, usable: false });
      } catch (error) {
        sendStoreError(res, error);
      }
    }
  );

  app.post(
    "/api/reviews/:id/analyze",
    requireJsonBytes(4 * 1024),
    requireAuth(store),
    requireCsrf,
    requireRoles("export-control-officer", "reviewer", "counsel"),
    async (req, res) => {
    const allowed = new Set([
      "requestId", "depth", "expectedVersion", "expectedRevision", "expectedHash"
    ]);
    const memoId = coerceReviewId(req, res);
    const bindings = coerceReviewBindings(req.body);
    const dispatchRequestId = coerceUuid(req.body?.requestId);
    if (!memoId) return;
    if (!bindings || !dispatchRequestId || !isRecord(req.body) ||
        Object.keys(req.body).some((key) => !allowed.has(key))) {
      res.status(400).json({ code: "review_binding_required", error: "Analysis requires a UUID requestId plus the current review version, revision, and hash." });
      return;
    }
    const detail = await store.getReviewDetail(res.locals.user.id, memoId);
    const memo = detail?.review;
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    if (!reviewMatchesBindings(memo, bindings)) {
      res.status(409).json({ code: "stale_revision", error: "The review changed before analysis started. Reload and try again." });
      return;
    }
    const dataClass = storedAiDataClass(res, memo.dataClass);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;

    const depth = coerceReviewDepth(req.body?.depth);
    let approval: AiApprovalStatus | undefined;
    let approvalSubject: AiApprovalSubjectBinding;
    try {
      const expected = councilApprovalExpectation(memo, depth, dataClass);
      approvalSubject = expected.subject;
      approval = await store.getCurrentAiApproval(res.locals.user.id, {
        purpose: "council",
        subjectKind: "review",
        subjectId: memo.id
      });
      if (!isApprovalUsable(approval, expected, dataClass)) {
        res.status(403).json({
          code: "ai_officer_approval_required",
          error: "An export-control officer must approve this exact memo revision, analysis depth, and provider policy before AI analysis."
        });
        return;
      }
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      throw error;
    }
    let result: ReviewResult;
    try {
      result = await runCouncilAnalysis(memo, {
        depth,
        maxTokens: depth === "deep" ? 3600 : undefined,
        onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample),
        providerClient: aiProviderClient,
        egress: approvedAiEgressContext(
          res,
          dataClass,
          approval!.approval.id,
          `council:${dispatchRequestId}`,
          approvalSubject
        )
      });
    } catch (error) {
      sendCouncilError(res, error);
      return;
    }
    result = bindReviewResult(result, memo, res.locals.user.id);
    let transition;
    try {
      transition = await store.setAnalysisResult(
        res.locals.user.id,
        memo,
        result,
        {
          completion: authoritativeReviewAuditEvent(
            res.locals.user,
            memo.id,
            "Analysis completed",
            result.provider.message,
            result.provider.live ? "info" : "review"
          ),
          decisionInvalidation: authoritativeReviewAuditEvent(
            res.locals.user,
            memo.id,
            "Reviewer decision invalidated",
            "A new analysis run requires a fresh reviewer decision.",
            "review"
          )
        }
      );
    } catch (error) {
      if (error instanceof StoreError) {
        sendStoreError(res, error);
        return;
      }
      throw error;
    }
    res.json({
      review: transition.review,
      result: transition.result,
      decisionInvalidated: transition.decisionInvalidated,
      auditEvents: transition.auditEvents
    });
    }
  );

  app.post("/api/ai/review", requireAuth(store), requireCsrf, (_req, res) => {
    res.status(410).json({
      code: "client_upgrade_required",
      error: "Ad-hoc AI review is retired. Save the memo as a review, obtain explicit AI approval, and analyze the bound review revision."
    });
  });

  app.post("/api/public-memo-draft", requireJsonBytes(16 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    if (!isRecord(req.body) || Object.keys(req.body).some((key) => key !== "item")) {
      res.status(400).json({
        code: "invalid_public_draft_request",
        error: "Public-source templates accept only a bounded item description."
      });
      return;
    }
    const item = coerceBoundedString(req.body.item, 1, 8_000);
    if (!item) {
      res.status(400).json({ error: "Item description is required." });
      return;
    }
    try {
      const draft = await createLocalPublicMemoTemplate(item);
      res.json(draft);
    } catch (error) {
      throw error;
    }
  });

  app.post("/api/documents/extract", requireJsonBytes(12 * 1024 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const allowed = new Set(["fileName", "mediaType", "dataBase64", "dataClass", "requestId"]);
    if (!isRecord(req.body) || Object.keys(req.body).some((key) => !allowed.has(key))) {
      res.status(400).json({
        code: "invalid_document_request",
        error: "Document extraction accepts only file metadata, bytes, classification, and a request ID."
      });
      return;
    }
    const fileName = normalizeText(req.body?.fileName, "attached-document");
    const mediaType = normalizeText(req.body?.mediaType, "application/octet-stream");
    const dataBase64 = normalizeText(req.body?.dataBase64, "");
    const requestId = coerceUuid(req.body?.requestId);
    const dataClass = requestAiDataClass(res, req.body?.dataClass);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;
    if (!dataBase64 || !requestId) {
      res.status(400).json({ error: "Document data and a UUID requestId are required." });
      return;
    }

    try {
      const prepared = prepareDocumentExtractionInput({ fileName, mediaType, dataBase64 });
      if (prepared.tooLarge) {
        const extraction = await extractDocumentText({ fileName, mediaType, dataBase64 });
        res.json({ extraction });
        return;
      }

      const runtime = getBedrockRuntime();
      const lane = resolveBedrockLane(runtime.model);
      if (prepared.requiresAi && lane && res.locals.user.role !== "export-control-officer") {
        const subject = documentApprovalSubject(prepared.input);
        res.status(403).json({
          code: "ai_officer_approval_required",
          error: "An export-control officer must approve and extract these exact file bytes. Ask an officer to select the same file and classification.",
          approvalRequest: {
            purpose: "document-extraction",
            subject,
            dataClass,
            fileName: prepared.input.fileName,
            mediaType: prepared.input.mediaType
          }
        });
        return;
      }

      let egress: AiEgressCallerContext | undefined;
      if (prepared.requiresAi && lane) {
        const subject = documentApprovalSubject(prepared.input);
        const payload = documentExtractionApprovalPayload(prepared.input);
        const approval = await store.createAiApproval(res.locals.user.id, {
          requestId,
          purpose: "document-extraction",
          subject,
          payloadHash: hashAiApprovalPayload(payload),
          providerRequestHashes: documentProviderPasses(prepared.input).map((pass) =>
            hashAiApprovalPayload(buildDocumentProviderRequest(prepared.input, lane, pass))
          ),
          dataClass,
          policy: currentAiApprovalPolicy(lane, dataClass),
          approvedBy: { id: res.locals.user.id, role: res.locals.user.role },
          dispatchLimit: prepared.input.mediaType === "application/pdf" ? 2 : 1
        });
        egress = approvedAiEgressContext(
          res,
          dataClass,
          approval.id,
          `document:${requestId}`,
          subject
        );
      }
      const extraction = await extractDocumentText(
        prepared.input,
        {
          onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample),
          providerClient: aiProviderClient,
          egress
        }
      );
      res.json({ extraction });
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      if (error instanceof DocumentValidationError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      if (error instanceof StoreError) {
        sendStoreError(res, error);
        return;
      }
      throw error;
    }
  });

  app.post("/api/ai/memo-builder-chat", requireJsonBytes(256 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const allowed = new Set(["sessionId", "pendingMessage", "requestId"]);
    const sessionId = coercePathId(req.body?.sessionId, "builder-", 128);
    const pendingMessage = coerceBoundedString(req.body?.pendingMessage, 1, 8_000);
    const requestId = coerceUuid(req.body?.requestId);
    if (!isRecord(req.body) || Object.keys(req.body).some((key) => !allowed.has(key)) ||
        !sessionId || !pendingMessage || !requestId) {
      res.status(400).json({
        code: "memo_builder_binding_required",
        error: "Memo Builder requires only a saved session ID, one bounded pending message, and a UUID requestId."
      });
      return;
    }
    const stored = await findMemoBuilderSession(store, res.locals.user.id, sessionId);
    if (!stored) {
      res.status(404).json({ code: "memo_builder_session_not_found", error: "Saved Memo Builder session not found." });
      return;
    }
    if (stored.session.messages.length >= 20) {
      res.status(409).json({
        code: "memo_builder_session_full",
        error: "This Memo Builder session reached its 20-message limit. Start a new chat to continue."
      });
      return;
    }
    const persistedPendingMessage = coerceBoundedString(stored.session.pendingInput, 1, 8_000);
    if (!persistedPendingMessage || persistedPendingMessage !== pendingMessage) {
      res.status(409).json({
        code: "memo_builder_pending_input_mismatch",
        error: "The pending message changed after the saved approval snapshot. Save the exact message and request approval again."
      });
      return;
    }
    const dataClass = storedAiDataClass(res, stored.session.dataClass);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;
    const messages: MemoBuildChatMessage[] = [
      ...stored.session.messages,
      { role: "user", content: pendingMessage }
    ];
    try {
      const expected = memoBuilderApprovalExpectation(stored, messages, dataClass);
      let approvalStatus = await store.getCurrentAiApproval(res.locals.user.id, {
        purpose: "memo-builder",
        subjectKind: "memo-builder",
        subjectId: stored.session.id
      });
      if (res.locals.user.role === "export-control-officer") {
        const approval = await store.createAiApproval(res.locals.user.id, {
          requestId,
          purpose: "memo-builder",
          ...expected,
          dataClass,
          approvedBy: { id: res.locals.user.id, role: res.locals.user.role },
          dispatchLimit: 1
        });
        approvalStatus = { approval, current: true, dispatchesReserved: 0 };
      } else if (!isApprovalUsable(approvalStatus, expected, dataClass)) {
        res.status(403).json({
          code: "ai_officer_approval_required",
          error: "Request officer approval for this exact saved conversation, then retry without editing it."
        });
        return;
      }
      const result = await runMemoBuildChat(messages, {
        onUsage: (sample) => recordUsageSafe(store, res.locals.user, sample),
        providerClient: aiProviderClient,
        egress: approvedAiEgressContext(
          res,
          dataClass,
          approvalStatus!.approval.id,
          `memo-builder:${requestId}`,
          expected.subject
        )
      });
      res.json(result);
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      if (error instanceof StoreError) {
        sendStoreError(res, error);
        return;
      }
      throw error;
    }
  });

  app.post(
    "/api/reviews/:id/chat",
    requireJsonBytes(MEMO_CHAT_REQUEST_MAX_BYTES),
    requireAuth(store),
    requireCsrf,
    requireRoles("export-control-officer", "reviewer", "counsel"),
    async (req, res) => {
    const allowed = new Set([
      "message", "requestId", "expectedVersion", "expectedRevision", "expectedHash"
    ]);
    const memoId = coerceReviewId(req, res);
    const bindings = coerceReviewBindings(req.body);
    const requestId = coerceUuid(req.body?.requestId);
    if (!memoId) return;
    if (!bindings || !requestId || !isRecord(req.body) ||
        Object.keys(req.body).some((key) => !allowed.has(key))) {
      res.status(400).json({
        code: "review_binding_required",
        error: "Chat requires only a UUID requestId, one message, and the current review version, revision, and hash."
      });
      return;
    }
    const detail = await store.getReviewDetail(res.locals.user.id, memoId);
    const memo = detail?.review;
    if (!memo) {
      res.status(404).json({ error: "Review not found." });
      return;
    }
    if (!reviewMatchesBindings(memo, bindings)) {
      res.status(409).json({ code: "stale_revision", error: "The review changed before chat started. Reload and try again." });
      return;
    }
    const dataClass = storedAiDataClass(res, memo.dataClass);
    if (!dataClass || !enforceDataClass(res, dataClass)) return;

    const message = normalizeMemoChatMessage(req.body?.message);
    if (!message) {
      res.status(400).json({ error: "Chat message is required." });
      return;
    }

    const history = await loadAiApprovalChatHistory(store, res.locals.user.id, memo.id);
    const runtime = getBedrockRuntime();
    const lane = resolveBedrockLane(runtime.model);
    let messages: MemoChatMessage[];
    try {
      let egress: AiEgressCallerContext = {
        accountId: res.locals.user.id,
        dataClass,
        dispatchId: `memo-chat:${requestId}`
      };
      if (lane) {
        const expected = memoChatApprovalExpectation(memo, message, history, dataClass);
        let approvalStatus = await store.getCurrentAiApproval(res.locals.user.id, {
          purpose: "memo-chat",
          subjectKind: "review",
          subjectId: memo.id
        });
        if (res.locals.user.role === "export-control-officer") {
          const approval = await store.createAiApproval(res.locals.user.id, {
            requestId,
            purpose: "memo-chat",
            ...expected,
            memoChatHistoryHash: hashAiApprovalChatHistory(history),
            dataClass,
            approvedBy: { id: res.locals.user.id, role: res.locals.user.role },
            dispatchLimit: 1
          });
          approvalStatus = { approval, current: true, dispatchesReserved: 0 };
        } else if (!isApprovalUsable(approvalStatus, expected, dataClass)) {
          res.status(403).json({
            code: "ai_officer_approval_required",
            error: "Request officer approval for this exact message and current chat history, then retry without editing either."
          });
          return;
        }
        egress = approvedAiEgressContext(
          res,
          dataClass,
          approvalStatus!.approval.id,
          `memo-chat:${requestId}`,
          expected.subject
        );
      }
      messages = await buildMemoChatMessages(
        memo,
        message,
        history,
        (sample) => recordUsageSafe(store, res.locals.user, sample),
        egress,
        aiProviderClient
      );
    } catch (error) {
      if (sendAiEgressError(res, error)) return;
      if (error instanceof StoreError) {
        sendStoreError(res, error);
        return;
      }
      throw error;
    }
    const auditEvent = messages.some((item) => item.proposedMemoText)
      ? authoritativeReviewAuditEvent(
          res.locals.user,
          memo.id,
          "Memo chat suggestion drafted",
          "Rulix drafted a memo edit from reviewer-provided context.",
          "info"
        )
      : undefined;
    try {
      res.json(await store.appendBoundChat(res.locals.user.id, memo.id, {
        ...bindings,
        messages,
        ...(lane ? { aiDispatchId: `memo-chat:${requestId}` } : {}),
        auditEvent
      }));
    } catch (error) {
      sendStoreError(res, error);
    }
    }
  );

  app.post("/api/reviews/:id/chat/:messageId/apply", requireJsonBytes(4 * 1024), requireAuth(store), requireCsrf, async (req, res) => {
    const memoId = coerceReviewId(req, res);
    const messageId = coercePathId(req.params.messageId, "chat-", 128);
    const expectedVersion = coerceExpectedVersion(req.body?.expectedVersion, false);
    const expectedHash = isSha256(req.body?.expectedHash) ? req.body.expectedHash : undefined;
    const keys = Object.keys(req.body ?? {});
    if (
      !memoId
      || !messageId
      || expectedVersion === undefined
      || !expectedHash
      || keys.some((key) => key !== "expectedVersion" && key !== "expectedHash")
    ) {
      res.status(400).json({ code: "chat_apply_binding_required", error: "Apply requires only messageId plus the current review version and hash." });
      return;
    }
    try {
      res.json(await store.applyChatSuggestion(res.locals.user.id, memoId, {
        messageId,
        expectedVersion,
        expectedHash,
        auditEvent: authoritativeReviewAuditEvent(
          res.locals.user,
          memoId,
          "Memo chat suggestion applied",
          "A stored, revision-bound chat suggestion was applied by the reviewer.",
          "review"
        )
      }));
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  app.post(
    "/api/reviews/:id/decision",
    requireJsonBytes(16 * 1024),
    requireAuth(store),
    requireCsrf,
    requireRoles("export-control-officer", "reviewer", "counsel"),
    async (req, res) => {
    const memoId = coerceReviewId(req, res);
    if (!memoId) return;
    const memo = (await store.getReviewDetail(res.locals.user.id, memoId))?.review;
    if (!memo) {
      res.status(404).json({ error: "Review not found" });
      return;
    }

    const decision = coerceDecision(req.body, res.locals.user);
    if (!decision) {
      res.status(400).json({ error: "Decision requires action and notes." });
      return;
    }

    try {
      requireOrganizationCapability(
        res.locals.user.role,
        decisionCapability(decision.action)
      );
    } catch (error) {
      if (error instanceof OrganizationAuthorizationError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      throw error;
    }

    const expected = coerceDecisionBindings(req.body);
    if (!expected) {
      res.status(400).json({
        code: "decision_binding_required",
        error: "Decision requests must include the current memo version, revision, content hash, analysis ID, and analysis hash."
      });
      return;
    }

    const decisionAuditEvent = authoritativeReviewAuditEvent(
      res.locals.user,
      memo.id,
      `Reviewer decision: ${decision.action}`,
      decision.notes,
      decision.action === "override" ? "escalate" : decision.action === "request-info" ? "review" : "info"
    );
    let transition;
    try {
      transition = await store.setDecision(
        res.locals.user.id,
        memo.id,
        decision,
        decisionAuditEvent,
        expected
      );
    } catch (error) {
      if (error instanceof DecisionBindingError) {
        res.status(error.status).json({
          code: error.code,
          error: error.message,
          current: error.current
        });
        return;
      }
      if (error instanceof ReviewPolicyError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      if (error instanceof StoreError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    if (transition.review.assignedTo) {
      await store.appendNotifications(transition.review.assignedTo, [workspaceNotification(
        transition.review.assignedTo,
        memo.id,
        decision.action === "request-info" ? "request-info" : "decision",
        decision.action === "request-info" ? "More information requested" : "Review decision recorded",
        `${transition.review.title}: ${decision.notes}`
      )]).catch(() => undefined);
    }
    res.json(transition);
    }
  );

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const bodyError = error as { type?: unknown; status?: unknown; body?: unknown };
    if (bodyError?.type === "entity.too.large" || bodyError?.status === 413) {
      res.status(413).json({
        code: "request_body_too_large",
        error: "Request body exceeds the limit for this operation."
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in bodyError) {
      res.status(400).json({ code: "invalid_json", error: "Request body is not valid JSON." });
      return;
    }
    next(error);
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

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const correlationId = randomUUID();
    res.setHeader("X-Rulix-Correlation-Id", correlationId);
    console.error(JSON.stringify({
      event: "unhandled_request_error",
      correlationId,
      method: req.method,
      path: req.path,
      errorType: error instanceof Error ? error.name : "UnknownError"
    }));
    res.status(500).json({
      code: "internal_error",
      error: "The request could not be completed. Contact support with the correlation ID.",
      correlationId
    });
  });

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
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
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
  const urls = MARKETING_SITEMAP_PAGES.map((page) => {
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
  const canonical = `https://rulix.cloud${marketingCanonicalPath(meta)}`;
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
  return sharedMarketingPageForPath(pathname);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function createMemoRecord(
  input: Partial<NewReviewInput> & { dataClass: DataClass },
  owner: UserProfile
): MemoRecord {
  const createdAt = new Date().toISOString();
  const now = createdAt.slice(0, 10);
  const entityId = randomUUID();
  const memo: MemoRecord = {
    id: `review-${entityId}`,
    title: normalizeText(input.title, "New ECCN Classification Memo"),
    itemFamily: normalizeText(input.itemFamily, "Research equipment"),
    owner: owner.name,
    ownerId: owner.id,
    updatedAt: now,
    documentCode: `API-${now.replaceAll("-", "")}-${entityId.slice(0, 8).toUpperCase()}`,
    status: "draft",
    memoText: normalizeText(input.memoText, ""),
    attachments: Array.isArray(input.attachments) ? input.attachments.filter(isString) : [],
    dataClass: input.dataClass,
    sourcePath: input.sourcePath ?? "self-classification",
    manufacturer: normalizeOptional(input.manufacturer),
    intendedUse: normalizeOptional(input.intendedUse),
    revision: 1,
    createdAt,
    createdBy: owner.id,
    lifecycleStage: "draft",
    priority: input.priority ?? "normal",
    assignedTo: normalizeOptional(input.assignedTo),
    dueAt: normalizeOptional(input.dueAt),
    tags: Array.isArray(input.tags) ? input.tags.filter(isString).slice(0, 12) : [],
    version: 1
  };
  memo.contentHash = hashMemoContent(memo);
  return memo;
}

function coerceMemo(value: unknown): MemoRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<MemoRecord>;
  if (!input.memoText?.trim()) return undefined;
  const dataClass = parseDataClass(input.dataClass);
  if (!dataClass) return undefined;
  const now = new Date().toISOString().slice(0, 10);

  return {
    id: normalizeText(input.id, `adhoc-${randomUUID()}`),
    title: normalizeText(input.title, "Ad hoc ECCN Memo"),
    itemFamily: normalizeText(input.itemFamily, "Research equipment"),
    owner: normalizeText(input.owner, "API User"),
    updatedAt: normalizeText(input.updatedAt, now),
    documentCode: normalizeText(input.documentCode, `ADHOC-${now.replaceAll("-", "")}`),
    status: input.status ?? "draft",
    memoText: input.memoText,
    attachments: Array.isArray(input.attachments) ? input.attachments.filter(isString) : [],
    dataClass,
    sourcePath: input.sourcePath ?? "self-classification",
    manufacturer: normalizeOptional(input.manufacturer),
    intendedUse: normalizeOptional(input.intendedUse)
  };
}

function coerceDecision(
  value: unknown,
  user: UserProfile
): ReviewerDecision | undefined {
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

  const createdAt = new Date().toISOString();
  const decision: ReviewerDecision = {
    id: `decision-${randomUUID()}`,
    action: input.action,
    notes: input.notes.trim(),
    signerId: user.id,
    signedBy: user.name,
    signedAt: createdAt,
    createdAt
  };
  return decision;
}

function coerceDecisionBindings(value: unknown): DecisionExpectedBindings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<DecisionExpectedBindings>;
  if (
    !Number.isSafeInteger(input.expectedVersion)
    || (input.expectedVersion ?? 0) < 1
    || !Number.isSafeInteger(input.expectedRevision)
    || (input.expectedRevision ?? 0) < 1
    || !isSha256(input.expectedHash)
    || typeof input.expectedAnalysisId !== "string"
    || !input.expectedAnalysisId.trim()
    || input.expectedAnalysisId.length > 160
    || !isSha256(input.expectedAnalysisHash)
  ) {
    return undefined;
  }
  return {
    expectedVersion: input.expectedVersion!,
    expectedRevision: input.expectedRevision!,
    expectedHash: input.expectedHash!,
    expectedAnalysisId: input.expectedAnalysisId.trim(),
    expectedAnalysisHash: input.expectedAnalysisHash!
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function bindReviewResult(result: ReviewResult, memo: MemoRecord, userId: string): ReviewResult {
  const bound: ReviewResult = {
    ...result,
    id: result.id ?? `analysis-${randomUUID()}`,
    memoRevision: memo.revision ?? 1,
    inputHash: memo.contentHash ?? hashMemoContent(memo),
    corpusChecksum: result.corpusChecksum ?? officialCorpus.checksum,
    promptVersion: result.promptVersion ?? "rulix-council-v2",
    createdBy: userId
  };
  bound.resultHash = hashReviewResult(bound);
  return bound;
}

function coerceReviewId(req: Request, res: Response) {
  const memoId = coerceReviewEntityId(req.params.id);
  if (!memoId) {
    res.status(400).json({ code: "invalid_review_id", error: "Review ID is invalid." });
    return undefined;
  }
  return memoId;
}

function coerceReviewEntityId(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return isReviewId(raw) ? raw : undefined;
}

function coercePathId(value: unknown, prefix: string, maxLength: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string"
    && raw.length <= maxLength
    && raw.startsWith(prefix)
    && /^[A-Za-z0-9_-]+$/.test(raw)
    ? raw
    : undefined;
}

function coerceUuid(value: unknown) {
  return typeof value === "string"
    && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function coerceExpectedVersion(value: unknown, allowZero: boolean) {
  return Number.isSafeInteger(value) && (value as number) >= (allowZero ? 0 : 1)
    ? value as number
    : undefined;
}

function coerceReviewBindings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const expectedVersion = coerceExpectedVersion(input.expectedVersion, false);
  const expectedRevision = coerceExpectedVersion(input.expectedRevision, false);
  const expectedHash = isSha256(input.expectedHash) ? input.expectedHash : undefined;
  return expectedVersion !== undefined && expectedRevision !== undefined && expectedHash
    ? { expectedVersion, expectedRevision, expectedHash }
    : undefined;
}

function reviewMatchesBindings(memo: MemoRecord, expected: NonNullable<ReturnType<typeof coerceReviewBindings>>) {
  return memo.version === expected.expectedVersion
    && memo.revision === expected.expectedRevision
    && memo.contentHash === expected.expectedHash;
}

function coerceBoundedString(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : undefined;
}

function coercePageQuery(req: Request, res: Response) {
  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  const rawCursor = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 50
    || (rawCursor !== undefined && (
      typeof rawCursor !== "string"
      || rawCursor.length > 4096
      || !/^[A-Za-z0-9_.-]+$/.test(rawCursor)
    ))
  ) {
    res.status(400).json({ code: "invalid_page", error: "limit must be 1-50 and cursor must be a bounded opaque token." });
    return undefined;
  }
  return { limit, ...(typeof rawCursor === "string" ? { cursor: rawCursor } : {}) };
}

function coerceInitialOutreachPageQuery(req: Request, res: Response) {
  if (req.query.cursor !== undefined) {
    res.status(400).json({
      code: "invalid_outreach_workspace_page",
      error: "Continue each outreach collection through its collection-specific page endpoint."
    });
    return undefined;
  }
  return coercePageQuery(req, res);
}

function outreachPageMetadata(page: { items: unknown[]; nextCursor?: string }) {
  return {
    loadedCount: page.items.length,
    hasMore: Boolean(page.nextCursor),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
  };
}

async function outreachLeadRowsPage(store: AccountStore, userId: string, query: { limit: number; cursor?: string }) {
  const leadPage = await store.listOutreachLeadsPage(userId, query);
  const items = await Promise.all(leadPage.items.map(async (lead) => {
    const [draft, workflow] = await Promise.all([
      store.getOutreachDraft(userId, lead.leadId),
      store.getLeadWorkflow(userId, lead.leadId)
    ]);
    return { lead, ...(draft ? { draft } : {}), ...(workflow ? { workflow } : {}) };
  }));
  return { items, ...(leadPage.nextCursor ? { nextCursor: leadPage.nextCursor } : {}) };
}

function coerceAiApprovalRequestPageQuery(req: Request, res: Response) {
  const page = coercePageQuery(req, res);
  if (!page) return undefined;
  const rawStatus = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
  const status = rawStatus === undefined
    ? undefined
    : rawStatus === "pending" || rawStatus === "approved" || rawStatus === "rejected" ||
        rawStatus === "cancelled" || rawStatus === "expired"
      ? rawStatus as AiApprovalRequestStatusKind
      : undefined;
  if (rawStatus !== undefined && !status) {
    res.status(400).json({
      code: "invalid_ai_approval_request_status",
      error: "status must be pending, approved, rejected, cancelled, or expired."
    });
    return undefined;
  }
  return { ...page, ...(status ? { status } : {}) };
}

function coerceReviewPageQuery(req: Request, res: Response) {
  const page = coercePageQuery(req, res);
  if (!page) return undefined;
  const rawState = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
  const state: "active" | "archived" | "all" = rawState === undefined
    ? "active"
    : rawState === "active" || rawState === "archived" || rawState === "all"
      ? rawState
      : "active";
  if (rawState !== undefined && rawState !== "active" && rawState !== "archived" && rawState !== "all") {
    res.status(400).json({ code: "invalid_review_state", error: "state must be active, archived, or all." });
    return undefined;
  }
  const scalar = (value: unknown) => Array.isArray(value) ? value[0] : value;
  const rawSearch = scalar(req.query.search);
  const search = rawSearch === undefined ? undefined : coerceBoundedString(rawSearch, 1, 120);
  const rawLifecycle = scalar(req.query.lifecycleStage);
  const lifecycleStage: MemoRecord["lifecycleStage"] | undefined = rawLifecycle === undefined
    ? undefined
    : coerceReviewLifecycleStage(rawLifecycle);
  const rawAssignee = scalar(req.query.assignee);
  const assignee = rawAssignee === undefined ? undefined : coerceBoundedString(rawAssignee, 1, 128);
  const rawPriority = scalar(req.query.priority);
  const priority: MemoRecord["priority"] | undefined = rawPriority === undefined
    ? undefined
    : coerceCasePriority(rawPriority);
  const rawDue = scalar(req.query.due);
  const due: "overdue" | "today" | "next-7-days" | "none" | undefined = rawDue === undefined
    ? undefined
    : rawDue === "overdue" || rawDue === "today" || rawDue === "next-7-days" || rawDue === "none"
      ? rawDue
      : undefined;
  const rawSort = scalar(req.query.sort);
  const sort: "updated-desc" | "updated-asc" | undefined = rawSort === undefined
    ? "updated-desc" as const
    : rawSort === "updated-desc" || rawSort === "updated-asc"
      ? rawSort
      : undefined;
  const rawTags = req.query.tags;
  const tags = rawTags === undefined
    ? undefined
    : (Array.isArray(rawTags) ? rawTags : [rawTags])
        .flatMap((value) => typeof value === "string" ? value.split(",") : [])
        .map((value) => value.trim())
        .filter(Boolean);
  if (
    (rawSearch !== undefined && !search)
    || (rawLifecycle !== undefined && !lifecycleStage)
    || (rawAssignee !== undefined && !assignee)
    || (rawPriority !== undefined && !priority)
    || (rawDue !== undefined && !due)
    || !sort
    || (tags && (tags.length > 12 || tags.some((tag) => tag.length > 32)))
  ) {
    res.status(400).json({ code: "invalid_review_filter", error: "Review filters are invalid or exceed their bounded limits." });
    return undefined;
  }
  return {
    ...page,
    state,
    sort,
    ...(search ? { search } : {}),
    ...(lifecycleStage ? { lifecycleStage } : {}),
    ...(assignee ? { assignee } : {}),
    ...(priority ? { priority } : {}),
    ...(due ? { due } : {}),
    ...(tags?.length ? { tags: [...new Set(tags)] } : {})
  };
}

function coerceNotificationPageQuery(req: Request, res: Response) {
  const page = coercePageQuery(req, res);
  if (!page) return undefined;
  const raw = Array.isArray(req.query.unread) ? req.query.unread[0] : req.query.unread;
  if (raw !== undefined && raw !== "true" && raw !== "false") {
    res.status(400).json({ code: "invalid_notification_filter", error: "unread must be true or false." });
    return undefined;
  }
  return { ...page, ...(raw === "true" ? { unreadOnly: true } : {}) };
}

function coerceReviewMetadataCommand(value: unknown) {
  if (!isRecord(value)) return undefined;
  const bindings = coerceReviewBindings(value);
  if (!bindings) return undefined;
  const allowed = new Set([
    "expectedVersion", "expectedRevision", "expectedHash",
    "priority", "assignedTo", "dueAt", "tags", "lifecycleStage"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const patch: Partial<Pick<MemoRecord, "priority" | "assignedTo" | "dueAt" | "tags" | "lifecycleStage">> = {};
  const clear: Array<"assignedTo" | "dueAt"> = [];
  if (Object.prototype.hasOwnProperty.call(value, "priority")) {
    const priority = coerceCasePriority(value.priority);
    if (!priority) return undefined;
    patch.priority = priority;
  }
  if (Object.prototype.hasOwnProperty.call(value, "assignedTo")) {
    if (value.assignedTo === null) clear.push("assignedTo");
    else {
      const assignedTo = coerceBoundedString(value.assignedTo, 1, 128);
      if (!assignedTo) return undefined;
      patch.assignedTo = assignedTo;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "dueAt")) {
    if (value.dueAt === null) clear.push("dueAt");
    else if (typeof value.dueAt === "string" && value.dueAt.length <= 40 && Number.isFinite(Date.parse(value.dueAt))) {
      patch.dueAt = new Date(value.dueAt).toISOString();
    } else return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, "tags")) {
    if (!Array.isArray(value.tags) || value.tags.length > 12) return undefined;
    const tags = value.tags.map((tag) => typeof tag === "string" ? tag.trim() : "");
    if (tags.some((tag) => !tag || tag.length > 32)) return undefined;
    patch.tags = [...new Set(tags)];
  }
  if (Object.prototype.hasOwnProperty.call(value, "lifecycleStage")) {
    const lifecycleStage = coerceReviewLifecycleStage(value.lifecycleStage);
    if (!lifecycleStage) return undefined;
    patch.lifecycleStage = lifecycleStage;
  }
  if (Object.keys(patch).length + clear.length === 0) return undefined;
  return { ...bindings, patch, clear };
}

function coerceCasePriority(value: unknown): MemoRecord["priority"] | undefined {
  return value === "low" || value === "normal" || value === "high" || value === "urgent"
    ? value
    : undefined;
}

function coerceReviewLifecycleStage(value: unknown): MemoRecord["lifecycleStage"] | undefined {
  return value === "draft" || value === "needs-information" || value === "ready-for-analysis"
    || value === "in-review" || value === "changes-requested" || value === "ready-for-decision"
    || value === "approved" || value === "rejected" || value === "superseded" || value === "archived"
    ? value
    : undefined;
}

function coerceCommentInput(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["body", "mentions", "kind"].includes(key))) {
    return undefined;
  }
  const body = coerceBoundedString(value.body, 1, 4_000);
  const mentions = value.mentions === undefined ? [] : value.mentions;
  const kind = value.kind === undefined ? "comment" : value.kind;
  if (
    !body
    || !Array.isArray(mentions)
    || mentions.length > 20
    || mentions.some((mention) => typeof mention !== "string" || mention.length < 1 || mention.length > 128)
    || (kind !== "comment" && kind !== "request-information")
  ) return undefined;
  return {
    body,
    mentions: [...new Set(mentions as string[])],
    kind: kind as "comment" | "request-information"
  };
}

function coerceWorkspacePreferenceCommand(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => ![
    "expectedVersion", "selectedMemoId", "activeMemoBuilderSessionId",
    "onboardingCompletedAt", "dismissedGuidance", "savedReviewViews", "activeWorkspace",
    "lastAppRoute", "lastDashboardRoute"
  ].includes(key))) {
    return undefined;
  }
  const expectedVersion = coerceExpectedVersion(input.expectedVersion, true);
  const selectedMemoId = input.selectedMemoId === null
    ? null
    : coerceReviewEntityId(input.selectedMemoId);
  const activeMemoBuilderSessionId = input.activeMemoBuilderSessionId === null
    ? null
    : coercePathId(input.activeMemoBuilderSessionId, "builder-", 128);
  if (
    expectedVersion === undefined
    || (input.selectedMemoId !== undefined && selectedMemoId === undefined)
    || (input.activeMemoBuilderSessionId !== undefined && activeMemoBuilderSessionId === undefined)
  ) return undefined;
  const onboardingCompletedAt = input.onboardingCompletedAt === null
    ? null
    : input.onboardingCompletedAt === undefined
      ? undefined
      : typeof input.onboardingCompletedAt === "string"
        && input.onboardingCompletedAt.length <= 40
        && Number.isFinite(Date.parse(input.onboardingCompletedAt))
          ? new Date(input.onboardingCompletedAt).toISOString()
          : undefined;
  const dismissedGuidance = input.dismissedGuidance === undefined
    ? undefined
    : boundedStringArray(input.dismissedGuidance, 32, 80);
  const savedReviewViews = input.savedReviewViews === undefined
    ? undefined
    : coerceSavedReviewViews(input.savedReviewViews);
  const activeWorkspace: "operations" | "growth" | undefined = input.activeWorkspace === undefined
    ? undefined
    : input.activeWorkspace === "operations" || input.activeWorkspace === "growth"
      ? input.activeWorkspace
      : undefined;
  const lastAppRoute = coerceNullableRoute(input.lastAppRoute, "#/", 240);
  const lastDashboardRoute = coerceNullableRoute(input.lastDashboardRoute, "#", 240);
  if (
    (input.onboardingCompletedAt !== undefined && onboardingCompletedAt === undefined)
    || (input.dismissedGuidance !== undefined && dismissedGuidance === undefined)
    || (input.savedReviewViews !== undefined && savedReviewViews === undefined)
    || (input.activeWorkspace !== undefined && activeWorkspace === undefined)
    || (input.lastAppRoute !== undefined && lastAppRoute === undefined)
    || (input.lastDashboardRoute !== undefined && lastDashboardRoute === undefined)
  ) return undefined;
  return {
    expectedVersion,
    ...(input.selectedMemoId !== undefined ? { selectedMemoId } : {}),
    ...(input.activeMemoBuilderSessionId !== undefined ? { activeMemoBuilderSessionId } : {}),
    ...(input.onboardingCompletedAt !== undefined ? { onboardingCompletedAt } : {}),
    ...(dismissedGuidance !== undefined ? { dismissedGuidance } : {}),
    ...(savedReviewViews !== undefined ? { savedReviewViews } : {}),
    ...(activeWorkspace !== undefined ? { activeWorkspace } : {}),
    ...(input.lastAppRoute !== undefined ? { lastAppRoute } : {}),
    ...(input.lastDashboardRoute !== undefined ? { lastDashboardRoute } : {})
  };
}

function boundedStringArray(value: unknown, count: number, length: number) {
  if (!Array.isArray(value) || value.length > count) return undefined;
  const strings = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
  return strings.some((entry) => !entry || entry.length > length) ? undefined : [...new Set(strings)];
}

function coerceSavedReviewViews(value: unknown) {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const views = value.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["id", "name", "query", "createdAt"].includes(key))) return undefined;
    const id = coercePathId(entry.id, "view-", 128);
    const name = coerceBoundedString(entry.name, 1, 80);
    const query = typeof entry.query === "string" && entry.query.length <= 1_000 ? entry.query : undefined;
    const createdAt = typeof entry.createdAt === "string" && entry.createdAt.length <= 40 && Number.isFinite(Date.parse(entry.createdAt))
      ? new Date(entry.createdAt).toISOString()
      : undefined;
    return id && name && query !== undefined && createdAt ? { id, name, query, createdAt } : undefined;
  });
  return views.some((view) => !view) ? undefined : views as NonNullable<typeof views[number]>[];
}

function coerceNullableRoute(value: unknown, prefix: string, maxLength: number) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" && value.startsWith(prefix) && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function coerceNewReviewInput(value: unknown): NewReviewInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "requestId", "title", "itemFamily", "manufacturer", "intendedUse", "dataClass",
    "sourcePath", "memoText", "attachments", "priority", "assignedTo", "dueAt", "tags"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return undefined;
  const memoText = coerceBoundedString(input.memoText, 1, 200_000);
  const dataClass = parseDataClass(input.dataClass);
  const title = input.title === undefined
    ? "New ECCN Classification Memo"
    : coerceBoundedString(input.title, 1, 240);
  const itemFamily = input.itemFamily === undefined
    ? "Research equipment"
    : coerceBoundedString(input.itemFamily, 1, 240);
  const manufacturer = input.manufacturer === "" || input.manufacturer === undefined
    ? ""
    : coerceBoundedString(input.manufacturer, 1, 240);
  const intendedUse = input.intendedUse === "" || input.intendedUse === undefined
    ? ""
    : coerceBoundedString(input.intendedUse, 1, 4_000);
  const sourcePath = input.sourcePath;
  const sourcePaths = new Set(["manufacturer", "self-classification", "ccats", "cj", "unknown"]);
  const attachments = Array.isArray(input.attachments)
    && input.attachments.length <= 32
    && input.attachments.every((item) => typeof item === "string" && item.length <= 240)
      ? input.attachments as string[]
      : undefined;
  const priority = input.priority ?? "normal";
  const priorities = new Set(["low", "normal", "high", "urgent"]);
  const tags = input.tags === undefined
    ? []
    : Array.isArray(input.tags)
      && input.tags.length <= 12
      && input.tags.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 80)
        ? input.tags as string[]
        : undefined;
  const assignedTo = input.assignedTo === undefined
    ? undefined
    : coerceBoundedString(input.assignedTo, 1, 128);
  const dueAt = input.dueAt === undefined ? undefined : normalizeIsoDate(input.dueAt);
  if (
    !memoText || !dataClass || !title || !itemFamily
    || (manufacturer === undefined) || (intendedUse === undefined)
    || typeof sourcePath !== "string" || !sourcePaths.has(sourcePath)
    || !attachments || typeof priority !== "string" || !priorities.has(priority) || !tags
    || (input.assignedTo !== undefined && !assignedTo)
    || (input.dueAt !== undefined && !dueAt)
  ) return undefined;
  return {
    title,
    itemFamily,
    manufacturer,
    intendedUse,
    dataClass,
    sourcePath: sourcePath as NewReviewInput["sourcePath"],
    memoText,
    attachments,
    priority: priority as NewReviewInput["priority"],
    assignedTo,
    dueAt,
    tags
  };
}

function coerceMemoBuilderSession(value: unknown, expectedId: string | undefined): MemoBuilderSession | undefined {
  if (!expectedId || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "id", "title", "dataClass", "messages", "updatedAt", "starterPrompt", "contextMemoId", "pendingInput", "draft"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || input.id !== expectedId) return undefined;
  const title = coerceBoundedString(input.title, 1, 160);
  const dataClass = parseDataClass(input.dataClass);
  const updatedAt = normalizeIsoDate(input.updatedAt);
  const messages = Array.isArray(input.messages) && input.messages.length <= 20
    ? input.messages.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
        const record = message as Record<string, unknown>;
        if (Object.keys(record).some((key) => key !== "role" && key !== "content")) return undefined;
        const content = coerceBoundedString(record.content, 1, 8_000);
        if ((record.role !== "user" && record.role !== "assistant") || !content) return undefined;
        if (content.includes("Attached source documents for Sonnet:")) return undefined;
        return { role: record.role, content };
      })
    : undefined;
  if (!title || !dataClass || !updatedAt || !messages || messages.some((message) => !message)) return undefined;
  const optionalText = (key: string, limit: number) => input[key] === undefined
    ? undefined
    : coerceBoundedString(input[key], 1, limit);
  const starterPrompt = optionalText("starterPrompt", 8_000);
  const contextMemoId = input.contextMemoId === undefined
    ? undefined
    : coerceReviewEntityId(input.contextMemoId);
  const pendingInput = optionalText("pendingInput", 8_000);
  if (
    (input.starterPrompt !== undefined && !starterPrompt)
    || (input.contextMemoId !== undefined && !contextMemoId)
    || (input.pendingInput !== undefined && !pendingInput)
  ) return undefined;
  const draft = input.draft === undefined ? undefined : coerceBuilderDraft(input.draft);
  if (input.draft !== undefined && !draft) return undefined;
  const session: MemoBuilderSession = {
    id: expectedId,
    title,
    dataClass,
    messages: messages as MemoBuilderSession["messages"],
    updatedAt,
    ...(starterPrompt ? { starterPrompt } : {}),
    ...(contextMemoId ? { contextMemoId } : {}),
    ...(pendingInput ? { pendingInput } : {}),
    ...(draft ? { draft } : {})
  };
  return Buffer.byteLength(JSON.stringify(session), "utf8") <= 300_000 ? session : undefined;
}

function coerceBuilderDraft(value: unknown): NonNullable<MemoBuilderSession["draft"]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "title", "itemFamily", "manufacturer", "intendedUse", "dataClass", "memoText",
    "attachments", "source", "qualityChecks", "missingFacts", "sourceNotes", "reviewContextMemoId"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return undefined;
  const title = coerceBoundedString(input.title, 1, 240);
  const itemFamily = coerceBoundedString(input.itemFamily, 1, 240);
  const memoText = coerceBoundedString(input.memoText, 1, 80_000);
  const dataClass = parseDataClass(input.dataClass);
  if (!title || !itemFamily || !memoText || !dataClass) return undefined;
  const list = (key: string, count: number, length: number) => {
    const raw = input[key];
    if (raw === undefined) return undefined;
    return Array.isArray(raw) && raw.length <= count
      && raw.every((item) => typeof item === "string" && item.length <= length)
      ? raw as string[]
      : null;
  };
  const attachments = list("attachments", 16, 240);
  const qualityChecks = list("qualityChecks", 24, 1_000);
  const missingFacts = list("missingFacts", 24, 1_000);
  const sourceNotes = list("sourceNotes", 24, 1_000);
  if ([attachments, qualityChecks, missingFacts, sourceNotes].some((item) => item === null)) return undefined;
  const source = input.source;
  if (source !== undefined && !["chat", "attachments", "sample", "review-improvement"].includes(String(source))) return undefined;
  const manufacturer = input.manufacturer === undefined
    ? undefined
    : coerceBoundedString(input.manufacturer, 1, 240);
  const intendedUse = input.intendedUse === undefined
    ? undefined
    : coerceBoundedString(input.intendedUse, 1, 2_000);
  const reviewContextMemoId = input.reviewContextMemoId === undefined
    ? undefined
    : coerceReviewEntityId(input.reviewContextMemoId);
  if (
    (input.manufacturer !== undefined && !manufacturer)
    || (input.intendedUse !== undefined && !intendedUse)
    || (input.reviewContextMemoId !== undefined && !reviewContextMemoId)
  ) return undefined;
  return {
    title,
    itemFamily,
    dataClass,
    memoText,
    ...(manufacturer ? { manufacturer } : {}),
    ...(intendedUse ? { intendedUse } : {}),
    ...(attachments ? { attachments } : {}),
    ...(source ? { source: source as NonNullable<MemoBuilderSession["draft"]>["source"] } : {}),
    ...(qualityChecks ? { qualityChecks } : {}),
    ...(missingFacts ? { missingFacts } : {}),
    ...(sourceNotes ? { sourceNotes } : {}),
    ...(reviewContextMemoId ? { reviewContextMemoId } : {})
  };
}

function authoritativeReviewAuditEvent(
  user: UserProfile,
  memoId: string,
  action: string,
  detail: string,
  severity: AuditEvent["severity"],
  metadata: AuditEvent["metadata"] = {}
) {
  return {
    ...createAuditEvent(memoId, action, detail, severity, user.name),
    actorId: user.id,
    organizationId: user.organizationId ?? user.id,
    metadata: {
      actorType: "user",
      source: "authenticated-api",
      outcome: "succeeded",
      subjectType: "review",
      subjectId: memoId,
      ...metadata
    }
  } satisfies AuditEvent;
}

function workspaceNotification(
  userId: string,
  memoId: string | undefined,
  kind: WorkspaceNotification["kind"],
  title: string,
  detail: string
): WorkspaceNotification {
  return {
    id: `notification-${randomUUID()}`,
    userId,
    ...(memoId ? { memoId } : {}),
    kind,
    title: title.slice(0, 160),
    detail: detail.slice(0, 1_000),
    createdAt: new Date().toISOString()
  };
}

async function findReviewComment(
  store: AccountStore,
  userId: string,
  memoId: string,
  commentId: string
) {
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await store.listReviewComments(userId, memoId, { limit: 50, ...(cursor ? { cursor } : {}) });
    const comment = page.items.find((item) => item.id === commentId);
    if (comment) return comment;
    if (!page.nextCursor) return undefined;
    cursor = page.nextCursor;
  }
  return undefined;
}

function coerceAuthToken(value: unknown) {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : undefined;
}

function coerceUserRole(value: unknown): UserProfile["role"] | undefined {
  return value === "export-control-officer" ||
    value === "reviewer" ||
    value === "submitter" ||
    value === "counsel"
    ? value
    : undefined;
}

function jsonParserWithLimit(maxBytes: number) {
  return express.json({
    limit: maxBytes,
    verify: (req, _res, buffer) => {
      (req as Request & { rawJsonBytes?: number }).rawJsonBytes = buffer.byteLength;
    }
  });
}

function requireJsonBytes(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const received = (req as Request & { rawJsonBytes?: number }).rawJsonBytes ?? 0;
    if (received > maxBytes) {
      res.status(413).json({
        code: "request_body_too_large",
        error: `Request body exceeds the ${maxBytes}-byte limit for this operation.`
      });
      return;
    }
    next();
  };
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

function decisionCapability(action: ReviewerDecision["action"]): OrganizationCapability {
  switch (action) {
    case "accept": return "decision:accept";
    case "request-info": return "decision:request-info";
    case "override": return "decision:override";
  }
}

function requireRoles(...roles: UserProfile["role"][]) {
  const allowed = new Set(roles);
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as UserProfile | undefined;
    if (!user || !allowed.has(user.role)) {
      res.status(403).json({ code: "forbidden", error: "Your workspace role cannot perform this action." });
      return;
    }
    next();
  };
}

function enforceDataClass(res: Response, value: unknown) {
  const dataClass = parseDataClass(value);
  if (!dataClass) {
    res.status(422).json({
      code: "data_class_required",
      error: "Select one recognized data classification before using this operation."
    });
    return false;
  }
  if (dataClass === "public" || dataClass === "proprietary") return true;
  const approved = process.env.RULIX_CONTROLLED_DATA_MODE?.trim().toLowerCase() === "approved" &&
    Boolean(process.env.RULIX_APPROVED_PROVIDER?.trim()) &&
    Boolean(process.env.RULIX_APPROVED_REGION?.trim());
  if (approved) return true;
  res.status(422).json({
    code: "data_class_not_allowed",
    error: "This environment is limited to public and proprietary data. Do not submit export-controlled, ITAR-risk, or CUI content."
  });
  return false;
}

function storedAiDataClass(res: Response, value: unknown) {
  const persisted = parseDataClass(value);
  if (!persisted) {
    res.status(422).json({
      code: "data_class_required",
      error: "The stored record has no recognized data classification."
    });
    return undefined;
  }
  const floor = deploymentAiDataClass(res);
  return floor ? maxDataClass(persisted, floor) : undefined;
}

function deploymentAiDataClass(res: Response) {
  try {
    return deploymentDataClass();
  } catch (error) {
    if (sendAiEgressError(res, error)) return undefined;
    throw error;
  }
}

function requestAiDataClass(res: Response, value: unknown) {
  const asserted = parseDataClass(value);
  if (!asserted) {
    res.status(422).json({
      code: "data_class_required",
      error: "An explicit recognized data classification is required before any AI provider dispatch."
    });
    return undefined;
  }
  const floor = deploymentAiDataClass(res);
  if (!floor) return undefined;
  return maxDataClass(floor, asserted);
}

interface AiApprovalExpectation {
  subject: AiApprovalSubjectBinding;
  payloadHash: string;
  providerRequestHashes: string[];
  policy: AiApprovalPolicyBinding;
}

function approvedAiEgressContext(
  res: Response,
  dataClass: DataClass,
  approvalId: string,
  dispatchId: string,
  subject: AiApprovalSubjectBinding
): AiEgressCallerContext {
  return {
    accountId: res.locals.user.id,
    approvalId,
    dataClass,
    dispatchId,
    subject
  };
}

function trustedAiEgressContext(
  res: Response,
  dataClass: DataClass,
  workflow: AiTrustedWorkflow,
  subjectId: string,
  requestId: string
): AiEgressCallerContext {
  const trustedSubjectId = `${workflow}:${sha256Canonical({
    accountId: res.locals.user.id,
    subjectId,
    requestId
  })}`;
  return {
    accountId: res.locals.user.id,
    dataClass,
    dispatchId: `${trustedSubjectId}:dispatch`,
    trustedWorkflowGrant: issueTrustedAiWorkflowGrant(workflow, trustedSubjectId)
  };
}

function reviewApprovalSubject(memo: MemoRecord): AiApprovalSubjectBinding {
  if (typeof memo.version !== "number" || !Number.isSafeInteger(memo.version) || memo.version < 1 ||
      typeof memo.revision !== "number" || !Number.isSafeInteger(memo.revision) || memo.revision < 1 ||
      typeof memo.contentHash !== "string" || !isSha256(memo.contentHash)) {
    throw new StoreError(
      409,
      "Reload the authoritative review revision before requesting AI approval.",
      "ai_approval_subject_invalid"
    );
  }
  return {
    kind: "review",
    id: memo.id,
    version: memo.version,
    revision: memo.revision,
    contentHash: memo.contentHash
  };
}

function councilApprovalExpectation(
  memo: MemoRecord,
  depth: CouncilDepth,
  dataClass: DataClass
): AiApprovalExpectation {
  const model = councilModelForDepth(depth, getBedrockRuntime());
  const lane = resolveBedrockLane(model);
  if (!lane) {
    throw new AiEgressPolicyError(
      "ai_provider_unavailable",
      "The approved council provider is not configured.",
      503
    );
  }
  const semanticPayload = councilApprovalPayload(memo, depth);
  const providerRequest = buildCouncilProviderRequest(memo, depth, model).body;
  return {
    subject: reviewApprovalSubject(memo),
    payloadHash: hashAiApprovalPayload(semanticPayload),
    providerRequestHashes: [hashAiApprovalPayload(providerRequest)],
    policy: currentAiApprovalPolicy(lane, dataClass)
  };
}

function memoChatApprovalExpectation(
  memo: MemoRecord,
  message: string,
  history: MemoChatMessage[],
  dataClass: DataClass
): AiApprovalExpectation {
  const runtime = getBedrockRuntime();
  const lane = resolveBedrockLane(runtime.model);
  if (!lane) {
    throw new AiEgressPolicyError(
      "ai_provider_unavailable",
      "The approved memo-chat provider is not configured.",
      503
    );
  }
  return {
    subject: reviewApprovalSubject(memo),
    payloadHash: hashAiApprovalPayload(memoChatApprovalPayload(memo, message, history)),
    providerRequestHashes: [
      hashAiApprovalPayload(buildMemoChatProviderRequest(memo, message, history, lane.model))
    ],
    policy: currentAiApprovalPolicy(lane, dataClass)
  };
}

function memoBuilderApprovalExpectation(
  stored: StoredMemoBuilderSession,
  messages: MemoBuildChatMessage[],
  dataClass: DataClass
): AiApprovalExpectation {
  const lane = resolveMemoBuilderProviderLane();
  if (!lane) {
    throw new AiEgressPolicyError(
      "ai_provider_unavailable",
      "The approved Memo Builder provider is not configured.",
      503
    );
  }
  return {
    subject: memoBuilderApprovalSubject(stored),
    payloadHash: hashAiApprovalPayload(memoBuilderApprovalPayload(messages)),
    providerRequestHashes: [
      hashAiApprovalPayload(buildMemoBuilderProviderRequest(messages, lane.model))
    ],
    policy: currentAiApprovalPolicy(lane, dataClass)
  };
}

function documentApprovalSubject(
  input: Parameters<typeof documentExtractionApprovalPayload>[0]
): AiApprovalSubjectBinding {
  const document = documentExtractionApprovalPayload(input).document;
  return {
    kind: "document",
    id: `document-${document.bytesSha256.slice(0, 40)}`,
    version: 1,
    contentHash: document.bytesSha256
  };
}

function memoBuilderApprovalSubject(stored: StoredMemoBuilderSession): AiApprovalSubjectBinding {
  return {
    kind: "memo-builder",
    id: stored.session.id,
    version: stored.version,
    contentHash: hashAiBuilderSession(stored.session)
  };
}

async function buildAiApprovalOfficerDetail(
  store: AccountStore,
  detail: AiApprovalRequestOfficerDetail
) {
  const status = detail.approvalRequest;
  const request = status.request;
  if (request.subject.kind === "review") {
    const reviewDetail = await store.getReviewDetail(request.targetAccountId, request.subject.id);
    const memo = reviewDetail?.review;
    if (!memo) {
      return {
        ...detail,
        inspection: {
          kind: request.purpose,
          current: false,
          unavailableReason: "The target review no longer exists. Reject this request."
        }
      };
    }
    if (request.purpose === "council") {
      const depth = request.context.kind === "council" ? request.context.depth : "standard";
      try {
        const currentDataClass = effectiveStoredAiDataClass(memo.dataClass);
        const expected = councilApprovalExpectation(memo, depth, currentDataClass);
        const providerRequest = buildCouncilProviderRequest(
          memo,
          depth,
          expected.policy.model
        ).body;
        return {
          ...detail,
          inspection: {
            kind: "council" as const,
            current: approvalRequestMatchesExpectation(request, expected, currentDataClass),
            depth,
            memo,
            providerRequest,
            providerRequestHash: hashAiApprovalPayload(providerRequest)
          }
        };
      } catch (error) {
        return {
          ...detail,
          inspection: {
            kind: "council" as const,
            current: false,
            depth,
            memo,
            unavailableReason: error instanceof Error ? error.message : "The provider policy is unavailable."
          }
        };
      }
    }
    const history = await loadAiApprovalChatHistory(store, request.targetAccountId, memo.id);
    const pendingMessage = detail.pendingContent?.kind === "memo-chat"
      ? detail.pendingContent.text
      : undefined;
    if (!pendingMessage) {
      return {
        ...detail,
        inspection: {
          kind: "memo-chat" as const,
          current: false,
          memo,
          history,
          unavailableReason: "The short-lived pending message preview is no longer available."
        }
      };
    }
    try {
      const currentDataClass = effectiveStoredAiDataClass(memo.dataClass);
      const expected = memoChatApprovalExpectation(memo, pendingMessage, history, currentDataClass);
      const providerRequest = buildMemoChatProviderRequest(
        memo,
        pendingMessage,
        history,
        expected.policy.model
      );
      return {
        ...detail,
        inspection: {
          kind: "memo-chat" as const,
          current: approvalRequestMatchesExpectation(request, expected, currentDataClass)
            && request.context.kind === "memo-chat"
            && request.context.pendingMessageHash === hashAiApprovalPayload(pendingMessage)
            && request.context.historyHash === hashAiApprovalChatHistory(history),
          memo,
          history,
          pendingMessage,
          providerRequest,
          providerRequestHash: hashAiApprovalPayload(providerRequest)
        }
      };
    } catch (error) {
      return {
        ...detail,
        inspection: {
          kind: "memo-chat" as const,
          current: false,
          memo,
          history,
          pendingMessage,
          unavailableReason: error instanceof Error ? error.message : "The provider policy is unavailable."
        }
      };
    }
  }

  const stored = await findMemoBuilderSession(store, request.targetAccountId, request.subject.id);
  const pendingMessage = coerceBoundedString(stored?.session.pendingInput, 1, 8_000);
  if (!stored || !pendingMessage) {
    return {
      ...detail,
      inspection: {
        kind: "memo-builder" as const,
        current: false,
        unavailableReason: "The exact saved Memo Builder input is no longer available. Reject this request."
      }
    };
  }
  const messages: MemoBuildChatMessage[] = [
    ...stored.session.messages,
    { role: "user", content: pendingMessage }
  ];
  try {
    const currentDataClass = effectiveStoredAiDataClass(stored.session.dataClass);
    const expected = memoBuilderApprovalExpectation(stored, messages, currentDataClass);
    const providerRequest = buildMemoBuilderProviderRequest(messages, expected.policy.model);
    return {
      ...detail,
      inspection: {
        kind: "memo-builder" as const,
        current: approvalRequestMatchesExpectation(request, expected, currentDataClass),
        session: stored.session,
        version: stored.version,
        messages,
        pendingMessage,
        providerRequest,
        providerRequestHash: hashAiApprovalPayload(providerRequest)
      }
    };
  } catch (error) {
    return {
      ...detail,
      inspection: {
        kind: "memo-builder" as const,
        current: false,
        session: stored.session,
        version: stored.version,
        messages,
        pendingMessage,
        unavailableReason: error instanceof Error ? error.message : "The provider policy is unavailable."
      }
    };
  }
}

function approvalRequestMatchesExpectation(
  request: AiApprovalRequestRecord,
  expected: AiApprovalExpectation,
  currentDataClass: DataClass
) {
  return request.dataClass === currentDataClass
    && sameAiApprovalSubject(request.subject, expected.subject)
    && request.payloadHash === expected.payloadHash
    && sameAiApprovalPolicy(request.policy, expected.policy)
    && request.providerRequestHashes.length === expected.providerRequestHashes.length
    && request.providerRequestHashes.every((hash, index) => hash === expected.providerRequestHashes[index]);
}

function effectiveStoredAiDataClass(value: unknown) {
  const stored = parseDataClass(value);
  if (!stored) {
    throw new AiEgressPolicyError(
      "ai_data_class_required",
      "The current target no longer has a recognized data classification."
    );
  }
  return maxDataClass(deploymentDataClass(), stored);
}

function isApprovalUsable(
  status: AiApprovalStatus | undefined,
  expected: AiApprovalExpectation,
  dataClass: DataClass
) {
  if (!status?.current || status.revocation || Date.parse(status.approval.expiresAt) <= Date.now()) {
    return false;
  }
  const approval = status.approval;
  return status.dispatchesReserved < approval.dispatchLimit
    && approval.dataClass === dataClass
    && approval.payloadHash === expected.payloadHash
    && sameAiApprovalSubject(approval.subject, expected.subject)
    && sameAiApprovalPolicy(approval.policy, expected.policy)
    && approval.providerRequestHashes.length === expected.providerRequestHashes.length
    && approval.providerRequestHashes.every((hash, index) => hash === expected.providerRequestHashes[index]);
}

async function findMemoBuilderSession(
  store: AccountStore,
  accountId: string,
  sessionId: string
) {
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await store.listMemoBuilderSessions(accountId, { limit: 50, cursor });
    const found = result.items.find((item) => item.session.id === sessionId);
    if (found) return found;
    if (!result.nextCursor) return undefined;
    cursor = result.nextCursor;
  }
  throw new StoreError(
    503,
    "Memo Builder session lookup exceeded its safe page limit.",
    "memo_builder_lookup_limit"
  );
}

async function loadAiApprovalChatHistory(
  store: AccountStore,
  accountId: string,
  memoId: string
) {
  const messages: MemoChatMessage[] = [];
  let cursor: string | undefined;
  // The authorization store binds the latest 200 messages. Load exactly that
  // bounded window so officer inspection, approval, and provider input agree.
  for (let page = 0; page < 4; page += 1) {
    const result = await store.listReviewChatMessages(accountId, memoId, { limit: 50, cursor });
    messages.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return messages.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function requireDataClass(res: Response, value: unknown) {
  const dataClass = parseDataClass(value);
  if (dataClass) return dataClass;
  res.status(422).json({
    code: "data_class_required",
    error: "Select one recognized data classification before using this operation."
  });
  return undefined;
}

function requireCsrf(_req: Request, res: Response, next: NextFunction) {
  const session = res.locals.session as SessionRecord | undefined;
  const token = _req.get("x-rulix-csrf");
  if (!session || !constantTimeStringEqual(token, session.csrfToken)) {
    res.status(403).json({ error: "Security token expired. Refresh and sign in again." });
    return;
  }
  next();
}

function setSessionCookie(res: Response, session: AuthSession) {
  res.cookie(sessionCookieName(), session.rawToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    maxAge: sessionTtlMs(),
    path: "/"
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(sessionCookieName(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    path: "/"
  });
}

function readSessionCookie(req: Request) {
  return parseCookies(req.get("cookie"))[sessionCookieName()];
}

function sessionCookieName() {
  return process.env.NODE_ENV === "production"
    ? PRODUCTION_SESSION_COOKIE
    : DEVELOPMENT_SESSION_COOKIE;
}

function parseCookies(header: string | undefined) {
  const cookies = Object.create(null) as Record<string, string>;
  if (!header) return cookies;
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim();
    const equalsAt = part.indexOf("=");
    if (equalsAt <= 0) continue;
    try {
      const name = decodeURIComponent(part.slice(0, equalsAt));
      const value = decodeURIComponent(part.slice(equalsAt + 1));
      if (name && !Object.prototype.hasOwnProperty.call(cookies, name)) {
        cookies[name] = value;
      }
    } catch {
      // A malformed unrelated cookie must not turn an anonymous request into a
      // 500 response or prevent a valid host-only session from being read.
    }
  }
  return cookies;
}

function constantTimeStringEqual(actual: string | undefined, expected: string) {
  if (typeof actual !== "string") return false;
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function sendStoreError(res: Response, error: unknown) {
  if (error instanceof StoreError) {
    res.status(error.status).json({
      ...(error.code ? { code: error.code } : {}),
      error: error.message
    });
    return;
  }
  throw error;
}

function sendCouncilError(res: Response, error: unknown) {
  if (sendAiEgressError(res, error)) return;
  if (error instanceof LiveCouncilUnavailableError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  throw error;
}

function sendAiEgressError(res: Response, error: unknown) {
  if (!(error instanceof AiEgressPolicyError)) return false;
  res.status(error.status).json({ code: error.code, error: error.message });
  return true;
}

// Persist a Bedrock usage sample for the admin dashboard. Best-effort: a
// failure here must never affect the user-facing AI response.
function recordUsageSafe(store: AccountStore, user: UserProfile, sample: UsageSample) {
  const event: UsageEvent = {
    id: `usage-${randomUUID()}`,
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
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(365, Math.floor(parsed))
    : fallback;
}

async function buildMemoChatMessages(
  memo: MemoRecord,
  reviewerMessage: string,
  history: MemoChatMessage[],
  onUsage: ((sample: UsageSample) => void) | undefined,
  egress: AiEgressCallerContext,
  providerClient?: AiProviderClient
): Promise<MemoChatMessage[]> {
  const chronology = memoChatPairTimestamps(history);
  const trimmedMessage = reviewerMessage.trim();
  const userMessage: MemoChatMessage = {
    id: `chat-${randomUUID()}`,
    memoId: memo.id,
    role: "user",
    text: trimmedMessage,
    createdAt: chronology.user,
    memoRevision: memo.revision,
    memoVersion: memo.version,
    memoHash: memo.contentHash
  };

  const aiResult = await runMemoChatWithHaiku(memo, trimmedMessage, history, {
    onUsage,
    egress,
    providerClient
  }).catch((error) => {
    if (error instanceof AiEgressPolicyError) throw error;
    return undefined;
  });
  if (aiResult) {
    return [
      userMessage,
      {
        id: `chat-${randomUUID()}`,
        memoId: memo.id,
        role: "assistant",
        text: aiResult.text,
        createdAt: chronology.assistant,
        proposedMemoText: aiResult.proposedMemoText,
        memoRevision: memo.revision,
        memoVersion: memo.version,
        memoHash: memo.contentHash
      }
    ];
  }

  const localResult = buildLocalMemoChatResult(memo, trimmedMessage);
  const assistantMessage: MemoChatMessage = {
    id: `chat-${randomUUID()}`,
    memoId: memo.id,
    role: "assistant",
    text: localResult.text,
    createdAt: chronology.assistant,
    proposedMemoText: localResult.proposedMemoText,
    memoRevision: memo.revision,
    memoVersion: memo.version,
    memoHash: memo.contentHash
  };
  return [userMessage, assistantMessage];
}

export function memoChatPairTimestamps(
  history: Pick<MemoChatMessage, "createdAt">[],
  nowMs = Date.now()
) {
  const latestHistoryMs = history.reduce((latest, message) => {
    const parsed = Date.parse(message.createdAt);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, Number.NEGATIVE_INFINITY);
  const userMs = Math.max(nowMs, Number.isFinite(latestHistoryMs) ? latestHistoryMs + 1 : nowMs);
  return {
    user: new Date(userMs).toISOString(),
    assistant: new Date(userMs + 1).toISOString()
  };
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

function rawString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseAccessRequest(value: unknown):
  | { input: CreateAccessRequestInput }
  | { error: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const email = normalizeText(body.email, "");
  const organization = normalizeText(body.organization, "");
  const role = normalizeText(body.role, "");
  const volume = normalizeText(body.volume, "");
  const review = normalizeOptional(body.review);
  const requestedPath = normalizeOptional(body.sourcePath);
  const sourcePath = requestedPath?.startsWith("/") ? requestedPath : "/";

  if (!email || !organization || !role || !volume) {
    return { error: "Work email, organization, role, and review volume are required." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: "Enter a valid work email address." };
  }
  if (!ACCESS_REQUEST_VOLUMES.has(volume)) {
    return { error: "Choose a valid review volume." };
  }
  if (organization.length > 160 || role.length > 120 || (review?.length ?? 0) > 1_200 || sourcePath.length > 200) {
    return { error: "One or more fields are too long." };
  }

  return {
    input: {
      email,
      organization,
      role,
      volume,
      review,
      sourcePath
    }
  };
}

function coerceOptionalBoundedString(value: unknown, maximum: number): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maximum ? normalized : null;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildLeadWorkflow(
  previous: LeadWorkflow | undefined,
  leadId: string,
  patch: Partial<LeadWorkflow>
) {
  const workflow: LeadWorkflow = {
    leadId,
    reviewStatus: previous?.reviewStatus ?? "new",
    lifecycleStatus: previous?.lifecycleStatus ?? "not-contacted",
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  };
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
