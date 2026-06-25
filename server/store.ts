import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";
import type {
  AccountReviewState,
  AuditEvent,
  MemoChatMessage,
  MemoRecord,
  ReviewResult,
  ReviewerDecision,
  UsageEvent,
  UserProfile
} from "../src/types";
import { defaultOutreachConfig, type StoredOutreachConfig } from "./aiClient";

const PASSWORD_ITERATIONS = 210_000;
const DEFAULT_SESSION_TTL_HOURS = 8;
const DEFAULT_INVITE_TTL_HOURS = 72;
const DEFAULT_RESET_TTL_MINUTES = 30;
const MAX_FAILED_ATTEMPTS = 6;
const LOCKOUT_MS = 1000 * 60 * 10;
const DEFAULT_TENANT_ID = "prod";

export interface UserRecord extends UserProfile {
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  failedAttempts: number;
  lockedUntil?: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  userEmail: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
}

export interface InviteRecord {
  id: string;
  tokenHash: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  status: "pending" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
  invitedBy?: string;
  usedAt?: string;
}

export interface ResetRecord {
  id: string;
  tokenHash: string;
  userId: string;
  userEmail: string;
  status: "pending" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
  usedAt?: string;
}

interface LockoutRecord {
  id: string;
  userId: string;
  userEmail: string;
  expiresAt: string;
  expiresAtEpoch: number;
}

interface PersistedStore {
  users: UserRecord[];
  sessions: SessionRecord[];
  invites: InviteRecord[];
  resets: ResetRecord[];
  accounts: Record<string, AccountReviewState>;
  usage: UsageEvent[];
  outreachConfig?: StoredOutreachConfig;
}

export interface ActiveSessionSummary {
  userId: string;
  lastSeenAt: string;
}

const USAGE_TTL_DAYS = 90;

interface CreateStoreOptions {
  filePath?: string;
  persist?: boolean;
}

export interface CreateInviteInput {
  email: string;
  name?: string;
  role?: UserProfile["role"];
  invitedBy?: string;
  expiresAt?: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  name: string;
  role: UserProfile["role"];
  status: InviteRecord["status"];
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
  usedAt?: string;
}

export interface InviteCreationResult {
  invite: InviteSummary;
  rawToken: string;
  inviteLink: string;
}

export interface InvitePublicInfo {
  email: string;
  name: string;
  role: UserProfile["role"];
  expiresAt: string;
  status: InviteRecord["status"];
}

export interface PasswordResetResult {
  email: string;
  rawToken?: string;
  resetLink?: string;
  expiresAt?: string;
}

export interface PasswordResetPublicInfo {
  email: string;
  expiresAt: string;
  status: ResetRecord["status"];
}

export interface AuthSession {
  rawToken: string;
  csrfToken: string;
  user: UserProfile;
}

export interface AccountStore {
  createInvite(input: CreateInviteInput): Promise<InviteCreationResult>;
  listInvites(): Promise<InviteSummary[]>;
  getInviteByToken(rawToken: string): Promise<InvitePublicInfo>;
  acceptInvite(rawToken: string, password: string, name?: string): Promise<AuthSession>;
  authenticate(emailInput: string, password: string): Promise<AuthSession>;
  requestPasswordReset(emailInput: string): Promise<PasswordResetResult>;
  getPasswordResetByToken(rawToken: string): Promise<PasswordResetPublicInfo>;
  completePasswordReset(rawToken: string, password: string): Promise<AuthSession>;
  getSession(rawToken: string | undefined): Promise<{ user: UserProfile; session: SessionRecord } | undefined>;
  destroySession(rawToken: string | undefined): Promise<void>;
  getAccountState(userId: string): Promise<AccountReviewState>;
  replaceAccountState(userId: string, state: AccountReviewState): Promise<void>;
  listReviews(userId: string): Promise<{
    reviews: MemoRecord[];
    decisions: Record<string, ReviewerDecision>;
    auditEvents: AuditEvent[];
    analysisResults: Record<string, ReviewResult>;
    chatMessages: Record<string, MemoChatMessage[]>;
  }>;
  upsertReview(userId: string, memo: MemoRecord): Promise<void>;
  updateReview(userId: string, memo: MemoRecord): Promise<void>;
  findReview(userId: string, memoId: string): Promise<MemoRecord | undefined>;
  setAnalysisResult(userId: string, memo: MemoRecord, result: ReviewResult): Promise<void>;
  setDecision(userId: string, memo: MemoRecord, decision: ReviewerDecision, auditEvent: AuditEvent): Promise<void>;
  appendAuditEvent(userId: string, event: AuditEvent): Promise<void>;
  appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]): Promise<MemoChatMessage[]>;
  recordUsage(event: UsageEvent): Promise<void>;
  getUsage(rangeDays?: number): Promise<UsageEvent[]>;
  listUsers(): Promise<UserProfile[]>;
  listActiveSessions(): Promise<ActiveSessionSummary[]>;
  getOutreachConfig(): Promise<StoredOutreachConfig>;
  setOutreachConfig(config: StoredOutreachConfig): Promise<void>;
}

export class LocalAccountStore implements AccountStore {
  private readonly filePath?: string;
  private readonly persistEnabled: boolean;
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, SessionRecord>();
  private invites = new Map<string, InviteRecord>();
  private resets = new Map<string, ResetRecord>();
  private accounts = new Map<string, AccountReviewState>();
  private usage: UsageEvent[] = [];
  private outreachConfig: StoredOutreachConfig = defaultOutreachConfig();

  constructor(options: CreateStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultStorePath();
    this.persistEnabled = options.persist ?? true;
    if (this.persistEnabled) {
      this.load();
    }
  }

  async createInvite(input: CreateInviteInput): Promise<InviteCreationResult> {
    const email = normalizeEmail(input.email);
    if (this.findUserByEmail(email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }
    if (Array.from(this.invites.values()).some((invite) => invite.email === email && invite.status === "pending" && !isExpired(invite.expiresAt))) {
      throw new StoreError(409, "A pending invite already exists for that email.");
    }

    const rawToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + inviteTtlMs()).toISOString();
    const invite: InviteRecord = {
      id: `invite-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      email,
      name: normalizeName(input.name ?? "", email),
      role: input.role ?? "reviewer",
      status: "pending",
      createdAt: now,
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt),
      invitedBy: input.invitedBy
    };
    this.invites.set(invite.tokenHash, invite);
    this.persist();
    return { invite: summarizeInvite(invite), rawToken, inviteLink: inviteLink(rawToken) };
  }

  async listInvites() {
    this.expireInvites();
    return Array.from(this.invites.values())
      .map(summarizeInvite)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getInviteByToken(rawToken: string): Promise<InvitePublicInfo> {
    const invite = this.invites.get(hashToken(rawToken));
    return publicInviteInfo(validateInvite(invite));
  }

  async acceptInvite(rawToken: string, password: string, name?: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const invite = validateInvite(this.invites.get(tokenHash));
    validatePassword(password);
    if (this.findUserByEmail(invite.email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }

    const user = createUserRecord(invite.email, name?.trim() || invite.name, invite.role, password);
    this.users.set(user.id, user);
    this.accounts.set(user.id, emptyAccountState());
    invite.status = "used";
    invite.usedAt = new Date().toISOString();
    this.invites.set(tokenHash, invite);
    const session = this.createSession(user);
    this.persist();
    return session;
  }

  async authenticate(emailInput: string, password: string): Promise<AuthSession> {
    const user = this.findUserByEmail(normalizeEmail(emailInput));
    if (!user) {
      hashPassword(password || "invalid-password", randomBytes(16).toString("base64url"), PASSWORD_ITERATIONS);
      throw new StoreError(401, "Invalid email or password.");
    }

    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      throw new StoreError(429, "Too many failed sign-in attempts. Try again later.");
    }

    if (!verifyPassword(password, user)) {
      recordFailedAttempt(user);
      this.users.set(user.id, user);
      this.persist();
      throw new StoreError(401, "Invalid email or password.");
    }

    clearFailedAttempts(user);
    this.users.set(user.id, user);
    const session = this.createSession(user);
    this.persist();
    return session;
  }

  async requestPasswordReset(emailInput: string): Promise<PasswordResetResult> {
    const email = normalizeEmail(emailInput);
    const user = this.findUserByEmail(email);
    if (!user) return { email };

    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + resetTtlMs()).toISOString();
    const reset: ResetRecord = {
      id: `reset-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      userId: user.id,
      userEmail: user.email,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt)
    };
    this.resets.set(reset.tokenHash, reset);
    this.persist();
    return { email, rawToken, resetLink: resetLink(rawToken), expiresAt };
  }

  async getPasswordResetByToken(rawToken: string): Promise<PasswordResetPublicInfo> {
    const reset = validateReset(this.resets.get(hashToken(rawToken)));
    return { email: reset.userEmail, expiresAt: reset.expiresAt, status: reset.status };
  }

  async completePasswordReset(rawToken: string, password: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const reset = validateReset(this.resets.get(tokenHash));
    validatePassword(password);
    const user = this.users.get(reset.userId);
    if (!user) throw new StoreError(404, "Password reset link is invalid or expired.");

    setUserPassword(user, password);
    clearFailedAttempts(user);
    reset.status = "used";
    reset.usedAt = new Date().toISOString();
    this.resets.set(tokenHash, reset);
    this.users.set(user.id, user);
    this.revokeUserSessions(user.id);
    const session = this.createSession(user);
    this.persist();
    return session;
  }

  async getSession(rawToken: string | undefined): Promise<{ user: UserProfile; session: SessionRecord } | undefined> {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const session = this.sessions.get(tokenHash);
    if (!session) return undefined;
    if (isExpired(session.expiresAt)) {
      this.sessions.delete(tokenHash);
      this.persist();
      return undefined;
    }

    const user = this.users.get(session.userId);
    if (!user) return undefined;
    session.lastSeenAt = new Date().toISOString();
    this.sessions.set(tokenHash, session);
    this.persist();
    return { user: publicUser(user), session };
  }

  async destroySession(rawToken: string | undefined) {
    if (!rawToken) return;
    this.sessions.delete(hashToken(rawToken));
    this.persist();
  }

  async getAccountState(userId: string): Promise<AccountReviewState> {
    const current = this.accounts.get(userId) ?? emptyAccountState();
    this.accounts.set(userId, current);
    return cloneAccountState(current);
  }

  async replaceAccountState(userId: string, state: AccountReviewState) {
    const incoming = normalizeAccountState(state);
    const existing = this.accounts.get(userId);
    this.accounts.set(userId, existing ? mergeAccountState(existing, incoming) : incoming);
    this.persist();
  }

  async listReviews(userId: string) {
    const state = await this.getAccountState(userId);
    return {
      reviews: state.memos,
      decisions: state.decisions,
      auditEvents: state.auditEvents,
      analysisResults: state.analysisResults,
      chatMessages: state.chatMessages
    };
  }

  async upsertReview(userId: string, memo: MemoRecord) {
    const state = await this.getAccountState(userId);
    state.memos = [memo, ...state.memos.filter((item) => item.id !== memo.id)];
    state.selectedMemoId = memo.id;
    await this.replaceAccountState(userId, state);
  }

  async updateReview(userId: string, memo: MemoRecord) {
    const state = await this.getAccountState(userId);
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    await this.replaceAccountState(userId, state);
  }

  async findReview(userId: string, memoId: string) {
    return (await this.getAccountState(userId)).memos.find((memo) => memo.id === memoId);
  }

  async setAnalysisResult(userId: string, memo: MemoRecord, result: ReviewResult) {
    const state = await this.getAccountState(userId);
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    state.analysisResults[result.memoId] = result;
    await this.replaceAccountState(userId, state);
  }

  async setDecision(userId: string, memo: MemoRecord, decision: ReviewerDecision, auditEvent: AuditEvent) {
    const state = await this.getAccountState(userId);
    state.decisions[memo.id] = decision;
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    state.auditEvents = [auditEvent, ...state.auditEvents];
    await this.replaceAccountState(userId, state);
  }

  async appendAuditEvent(userId: string, event: AuditEvent) {
    const state = await this.getAccountState(userId);
    state.auditEvents = [event, ...state.auditEvents];
    await this.replaceAccountState(userId, state);
  }

  async appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]) {
    const state = await this.getAccountState(userId);
    state.chatMessages[memoId] = [...(state.chatMessages[memoId] ?? []), ...messages];
    await this.replaceAccountState(userId, state);
    return state.chatMessages[memoId];
  }

  async recordUsage(event: UsageEvent) {
    this.usage.push(event);
    this.persist();
  }

  async getUsage(rangeDays?: number) {
    const cutoff = rangeDaysCutoff(rangeDays);
    return this.usage.filter((event) => Date.parse(event.at) >= cutoff);
  }

  async listUsers() {
    return Array.from(this.users.values()).map(publicUser);
  }

  async listActiveSessions(): Promise<ActiveSessionSummary[]> {
    return Array.from(this.sessions.values())
      .filter((session) => !isExpired(session.expiresAt))
      .map((session) => ({ userId: session.userId, lastSeenAt: session.lastSeenAt }));
  }

  async getOutreachConfig(): Promise<StoredOutreachConfig> {
    return { ...this.outreachConfig };
  }

  async setOutreachConfig(config: StoredOutreachConfig): Promise<void> {
    this.outreachConfig = { ...config };
    this.persist();
  }

  private createSession(user: UserRecord): AuthSession {
    const rawToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionTtlMs()).toISOString();
    const session: SessionRecord = {
      tokenHash: hashToken(rawToken),
      userId: user.id,
      userEmail: user.email,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt)
    };
    this.sessions.set(session.tokenHash, session);
    return { rawToken, csrfToken, user: publicUser(user) };
  }

  private revokeUserSessions(userId: string) {
    Array.from(this.sessions.entries()).forEach(([tokenHash, session]) => {
      if (session.userId === userId) this.sessions.delete(tokenHash);
    });
  }

  private expireInvites() {
    for (const [tokenHash, invite] of this.invites.entries()) {
      if (invite.status === "pending" && isExpired(invite.expiresAt)) {
        this.invites.set(tokenHash, { ...invite, status: "expired" });
      }
    }
    this.persist();
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedStore>;
      this.users = new Map((parsed.users ?? []).map((user) => [user.id, user]));
      this.sessions = new Map(
        (parsed.sessions ?? [])
          .filter((session) => !isExpired(session.expiresAt))
          .map((session) => [session.tokenHash, session])
      );
      this.invites = new Map((parsed.invites ?? []).map((invite) => [invite.tokenHash, invite]));
      this.resets = new Map((parsed.resets ?? []).map((reset) => [reset.tokenHash, reset]));
      this.accounts = new Map(
        Object.entries(parsed.accounts ?? {}).map(([userId, state]) => [
          userId,
          normalizeAccountState(state)
        ])
      );
      this.usage = Array.isArray(parsed.usage) ? parsed.usage : [];
      this.outreachConfig = parsed.outreachConfig ?? defaultOutreachConfig();
    } catch {
      this.users = new Map();
      this.sessions = new Map();
      this.invites = new Map();
      this.resets = new Map();
      this.accounts = new Map();
      this.usage = [];
      this.outreachConfig = defaultOutreachConfig();
    }
  }

  private persist() {
    if (!this.persistEnabled || !this.filePath) return;
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const payload: PersistedStore = {
      users: Array.from(this.users.values()),
      sessions: Array.from(this.sessions.values()).filter((session) => !isExpired(session.expiresAt)),
      invites: Array.from(this.invites.values()),
      resets: Array.from(this.resets.values()),
      accounts: Object.fromEntries(this.accounts.entries()),
      usage: this.usage,
      outreachConfig: this.outreachConfig
    };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  private findUserByEmail(email: string) {
    return Array.from(this.users.values()).find((user) => user.email === email);
  }
}

export class DynamoAccountStore implements AccountStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tenantId: string;

  constructor(
    private readonly authTable: string,
    private readonly accountTable: string,
    options: { tenantId?: string; client?: DynamoDBDocumentClient } = {}
  ) {
    this.tenantId = options.tenantId ?? process.env.RULIX_TENANT_ID ?? DEFAULT_TENANT_ID;
    this.doc = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true }
    });
  }

  async createInvite(input: CreateInviteInput): Promise<InviteCreationResult> {
    const email = normalizeEmail(input.email);
    if (await this.findUserByEmail(email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }
    const existingPending = (await this.listInvites()).some(
      (invite) => invite.email === email && invite.status === "pending" && !isExpired(invite.expiresAt)
    );
    if (existingPending) {
      throw new StoreError(409, "A pending invite already exists for that email.");
    }

    const rawToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + inviteTtlMs()).toISOString();
    const invite: InviteRecord = {
      id: `invite-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      email,
      name: normalizeName(input.name ?? "", email),
      role: input.role ?? "reviewer",
      status: "pending",
      createdAt: now,
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt),
      invitedBy: input.invitedBy
    };
    await this.putAuthItem(inviteKey(invite.tokenHash), invite);
    return { invite: summarizeInvite(invite), rawToken, inviteLink: inviteLink(rawToken) };
  }

  async listInvites() {
    const items = await this.queryAuthByPrefix("INVITE#");
    return items
      .map((item) => item.record as InviteRecord)
      .map((invite) => invite.status === "pending" && isExpired(invite.expiresAt) ? { ...invite, status: "expired" as const } : invite)
      .map(summarizeInvite)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getInviteByToken(rawToken: string): Promise<InvitePublicInfo> {
    const invite = await this.getAuthRecord<InviteRecord>(inviteKey(hashToken(rawToken)));
    return publicInviteInfo(validateInvite(invite));
  }

  async acceptInvite(rawToken: string, password: string, name?: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const invite = validateInvite(await this.getAuthRecord<InviteRecord>(inviteKey(tokenHash)));
    validatePassword(password);
    if (await this.findUserByEmail(invite.email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }

    const user = createUserRecord(invite.email, name?.trim() || invite.name, invite.role, password);
    await this.putAuthItem(userKey(user.email), user);
    await this.putAccountState(user.id, emptyAccountState());
    invite.status = "used";
    invite.usedAt = new Date().toISOString();
    await this.putAuthItem(inviteKey(tokenHash), invite);
    return this.createSession(user);
  }

  async authenticate(emailInput: string, password: string): Promise<AuthSession> {
    const user = await this.findUserByEmail(normalizeEmail(emailInput));
    if (!user) {
      hashPassword(password || "invalid-password", randomBytes(16).toString("base64url"), PASSWORD_ITERATIONS);
      throw new StoreError(401, "Invalid email or password.");
    }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      throw new StoreError(429, "Too many failed sign-in attempts. Try again later.");
    }
    if (!verifyPassword(password, user)) {
      recordFailedAttempt(user);
      await this.putAuthItem(userKey(user.email), user);
      if (user.lockedUntil) await this.putLockout(user);
      throw new StoreError(401, "Invalid email or password.");
    }

    clearFailedAttempts(user);
    await this.putAuthItem(userKey(user.email), user);
    await this.deleteAuthItem(lockoutKey(user.email));
    return this.createSession(user);
  }

  async requestPasswordReset(emailInput: string): Promise<PasswordResetResult> {
    const email = normalizeEmail(emailInput);
    const user = await this.findUserByEmail(email);
    if (!user) return { email };
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + resetTtlMs()).toISOString();
    const reset: ResetRecord = {
      id: `reset-${randomBytes(12).toString("base64url")}`,
      tokenHash: hashToken(rawToken),
      userId: user.id,
      userEmail: user.email,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt)
    };
    await this.putAuthItem(resetKey(reset.tokenHash), reset);
    return { email, rawToken, resetLink: resetLink(rawToken), expiresAt };
  }

  async getPasswordResetByToken(rawToken: string): Promise<PasswordResetPublicInfo> {
    const reset = validateReset(await this.getAuthRecord<ResetRecord>(resetKey(hashToken(rawToken))));
    return { email: reset.userEmail, expiresAt: reset.expiresAt, status: reset.status };
  }

  async completePasswordReset(rawToken: string, password: string): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const reset = validateReset(await this.getAuthRecord<ResetRecord>(resetKey(tokenHash)));
    validatePassword(password);
    const user = await this.getUserById(reset.userId);
    if (!user) throw new StoreError(404, "Password reset link is invalid or expired.");

    setUserPassword(user, password);
    clearFailedAttempts(user);
    reset.status = "used";
    reset.usedAt = new Date().toISOString();
    await this.putAuthItem(userKey(user.email), user);
    await this.putAuthItem(resetKey(tokenHash), reset);
    await this.deleteAuthItem(lockoutKey(user.email));
    await this.revokeUserSessions(user.id);
    return this.createSession(user);
  }

  async getSession(rawToken: string | undefined): Promise<{ user: UserProfile; session: SessionRecord } | undefined> {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const session = await this.getAuthRecord<SessionRecord>(sessionKey(tokenHash));
    if (!session) return undefined;
    if (isExpired(session.expiresAt)) {
      await this.deleteAuthItem(sessionKey(tokenHash));
      return undefined;
    }
    const user = await this.findUserByEmail(session.userEmail);
    if (!user) return undefined;
    session.lastSeenAt = new Date().toISOString();
    await this.putAuthItem(sessionKey(tokenHash), session);
    return { user: publicUser(user), session };
  }

  async destroySession(rawToken: string | undefined) {
    if (!rawToken) return;
    await this.deleteAuthItem(sessionKey(hashToken(rawToken)));
  }

  async getAccountState(userId: string): Promise<AccountReviewState> {
    const response = await this.doc.send(new GetCommand({
      TableName: this.accountTable,
      Key: { pk: accountKey(this.tenantId, userId) }
    }));
    return normalizeAccountState(response.Item?.state as Partial<AccountReviewState> | undefined);
  }

  async replaceAccountState(userId: string, state: AccountReviewState) {
    const existing = await this.getAccountState(userId);
    await this.putAccountState(userId, mergeAccountState(existing, normalizeAccountState(state)));
  }

  async listReviews(userId: string) {
    const state = await this.getAccountState(userId);
    return {
      reviews: state.memos,
      decisions: state.decisions,
      auditEvents: state.auditEvents,
      analysisResults: state.analysisResults,
      chatMessages: state.chatMessages
    };
  }

  async upsertReview(userId: string, memo: MemoRecord) {
    const state = await this.getAccountState(userId);
    state.memos = [memo, ...state.memos.filter((item) => item.id !== memo.id)];
    state.selectedMemoId = memo.id;
    await this.putAccountState(userId, state);
  }

  async updateReview(userId: string, memo: MemoRecord) {
    const state = await this.getAccountState(userId);
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    await this.putAccountState(userId, state);
  }

  async findReview(userId: string, memoId: string) {
    return (await this.getAccountState(userId)).memos.find((memo) => memo.id === memoId);
  }

  async setAnalysisResult(userId: string, memo: MemoRecord, result: ReviewResult) {
    const state = await this.getAccountState(userId);
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    state.analysisResults[result.memoId] = result;
    await this.putAccountState(userId, state);
  }

  async setDecision(userId: string, memo: MemoRecord, decision: ReviewerDecision, auditEvent: AuditEvent) {
    const state = await this.getAccountState(userId);
    state.decisions[memo.id] = decision;
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    state.auditEvents = [auditEvent, ...state.auditEvents];
    await this.putAccountState(userId, state);
  }

  async appendAuditEvent(userId: string, event: AuditEvent) {
    const state = await this.getAccountState(userId);
    state.auditEvents = [event, ...state.auditEvents];
    await this.putAccountState(userId, state);
  }

  async appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]) {
    const state = await this.getAccountState(userId);
    state.chatMessages[memoId] = [...(state.chatMessages[memoId] ?? []), ...messages];
    await this.putAccountState(userId, state);
    return state.chatMessages[memoId];
  }

  async recordUsage(event: UsageEvent) {
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + USAGE_TTL_DAYS * 24 * 60 * 60;
    await this.putAuthItem(usageKey(event.at, event.id), { ...event, expiresAtEpoch });
  }

  async getUsage(rangeDays?: number) {
    const cutoff = rangeDaysCutoff(rangeDays);
    const items = await this.queryAuthByPrefix("USAGE#");
    return items
      .map((item) => item.record as UsageEvent)
      .filter((event) => event && Date.parse(event.at) >= cutoff);
  }

  async listUsers() {
    const items = await this.queryAuthByPrefix("USER#");
    return items.map((item) => publicUser(item.record as UserRecord));
  }

  async listActiveSessions(): Promise<ActiveSessionSummary[]> {
    const items = await this.queryAuthByPrefix("SESSION#");
    return items
      .map((item) => item.record as SessionRecord)
      .filter((session) => session && !isExpired(session.expiresAt))
      .map((session) => ({ userId: session.userId, lastSeenAt: session.lastSeenAt }));
  }

  async getOutreachConfig(): Promise<StoredOutreachConfig> {
    const record = await this.getAuthRecord<StoredOutreachConfig>("CONFIG#outreach");
    return record ?? defaultOutreachConfig();
  }

  async setOutreachConfig(config: StoredOutreachConfig): Promise<void> {
    await this.putAuthItem("CONFIG#outreach", config);
  }

  private async createSession(user: UserRecord): Promise<AuthSession> {
    const rawToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionTtlMs()).toISOString();
    const session: SessionRecord = {
      tokenHash: hashToken(rawToken),
      userId: user.id,
      userEmail: user.email,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      expiresAtEpoch: toEpochSeconds(expiresAt)
    };
    await this.putAuthItem(sessionKey(session.tokenHash), session);
    return { rawToken, csrfToken, user: publicUser(user) };
  }

  private async findUserByEmail(email: string) {
    return this.getAuthRecord<UserRecord>(userKey(email));
  }

  private async getUserById(userId: string) {
    const items = await this.queryAuthByPrefix("USER#");
    return (items.map((item) => item.record as UserRecord).find((user) => user.id === userId));
  }

  private async revokeUserSessions(userId: string) {
    const sessions = await this.queryAuthByPrefix("SESSION#");
    await Promise.all(
      sessions
        .map((item) => item.record as SessionRecord)
        .filter((session) => session.userId === userId)
        .map((session) => this.deleteAuthItem(sessionKey(session.tokenHash)))
    );
  }

  private async putLockout(user: UserRecord) {
    if (!user.lockedUntil) return;
    const lockout: LockoutRecord = {
      id: `lockout-${user.id}`,
      userId: user.id,
      userEmail: user.email,
      expiresAt: user.lockedUntil,
      expiresAtEpoch: toEpochSeconds(user.lockedUntil)
    };
    await this.putAuthItem(lockoutKey(user.email), lockout);
  }

  private async getAuthRecord<T>(key: string) {
    const response = await this.doc.send(new GetCommand({
      TableName: this.authTable,
      Key: { pk: tenantKey(this.tenantId), sk: key }
    }));
    return response.Item?.record as T | undefined;
  }

  private async putAuthItem(key: string, record: unknown) {
    await this.doc.send(new PutCommand({
      TableName: this.authTable,
      Item: {
        pk: tenantKey(this.tenantId),
        sk: key,
        record,
        expiresAtEpoch: isRecord(record) && typeof record.expiresAtEpoch === "number" ? record.expiresAtEpoch : undefined
      }
    }));
  }

  private async deleteAuthItem(key: string) {
    await this.doc.send(new DeleteCommand({
      TableName: this.authTable,
      Key: { pk: tenantKey(this.tenantId), sk: key }
    }));
  }

  private async queryAuthByPrefix(prefix: string) {
    const response = await this.doc.send(new QueryCommand({
      TableName: this.authTable,
      KeyConditionExpression: "#pk = :pk and begins_with(#sk, :prefix)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: { ":pk": tenantKey(this.tenantId), ":prefix": prefix }
    }));
    return response.Items ?? [];
  }

  private async putAccountState(userId: string, state: AccountReviewState) {
    await this.doc.send(new PutCommand({
      TableName: this.accountTable,
      Item: {
        pk: accountKey(this.tenantId, userId),
        tenantId: this.tenantId,
        userId,
        state: normalizeAccountState(state),
        updatedAt: new Date().toISOString()
      }
    }));
  }
}

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function createAccountStore(options?: CreateStoreOptions): AccountStore {
  if (process.env.RULIX_AUTH_TABLE?.trim() && process.env.RULIX_ACCOUNT_TABLE?.trim()) {
    return new DynamoAccountStore(process.env.RULIX_AUTH_TABLE.trim(), process.env.RULIX_ACCOUNT_TABLE.trim());
  }
  return new LocalAccountStore(options);
}

export function emptyAccountState(): AccountReviewState {
  return {
    memos: [],
    decisions: {},
    auditEvents: [],
    analysisResults: {},
    chatMessages: {},
    memoBuilder: { messages: [] },
    outreachDrafts: {},
    discoveredLeads: [],
    leadSearchRuns: [],
    leadWorkflows: {},
    outreachJobs: []
  };
}

export function publicUser(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  };
}

export function sessionTtlMs() {
  return hoursToMs(readPositiveNumberEnv("AUTH_SESSION_TTL_HOURS", DEFAULT_SESSION_TTL_HOURS));
}

function inviteTtlMs() {
  return hoursToMs(readPositiveNumberEnv("AUTH_INVITE_TTL_HOURS", DEFAULT_INVITE_TTL_HOURS));
}

function resetTtlMs() {
  return readPositiveNumberEnv("AUTH_RESET_TTL_MINUTES", DEFAULT_RESET_TTL_MINUTES) * 60 * 1000;
}

function createUserRecord(email: string, name: string, role: UserProfile["role"], password: string): UserRecord {
  const salt = randomBytes(16).toString("base64url");
  return {
    id: `user-${randomBytes(12).toString("base64url")}`,
    email,
    name: normalizeName(name, email),
    role,
    createdAt: new Date().toISOString(),
    passwordHash: hashPassword(password, salt, PASSWORD_ITERATIONS),
    passwordSalt: salt,
    passwordIterations: PASSWORD_ITERATIONS,
    failedAttempts: 0
  };
}

function setUserPassword(user: UserRecord, password: string) {
  const salt = randomBytes(16).toString("base64url");
  user.passwordHash = hashPassword(password, salt, PASSWORD_ITERATIONS);
  user.passwordSalt = salt;
  user.passwordIterations = PASSWORD_ITERATIONS;
}

function recordFailedAttempt(user: UserRecord) {
  user.failedAttempts += 1;
  if (user.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    user.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
  }
}

function clearFailedAttempts(user: UserRecord) {
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
}

function validateInvite(invite: InviteRecord | undefined) {
  if (!invite) throw new StoreError(404, "Invite link is invalid or expired.");
  if (invite.status === "used") throw new StoreError(410, "Invite link has already been used.");
  if (invite.status === "expired" || isExpired(invite.expiresAt)) {
    invite.status = "expired";
    throw new StoreError(410, "Invite link is invalid or expired.");
  }
  return invite;
}

function validateReset(reset: ResetRecord | undefined) {
  if (!reset) throw new StoreError(404, "Password reset link is invalid or expired.");
  if (reset.status === "used") throw new StoreError(410, "Password reset link has already been used.");
  if (reset.status === "expired" || isExpired(reset.expiresAt)) {
    if (reset) reset.status = "expired";
    throw new StoreError(410, "Password reset link is invalid or expired.");
  }
  return reset;
}

function summarizeInvite(invite: InviteRecord): InviteSummary {
  return {
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    status: invite.status === "pending" && isExpired(invite.expiresAt) ? "expired" : invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    usedAt: invite.usedAt
  };
}

function publicInviteInfo(invite: InviteRecord): InvitePublicInfo {
  return {
    email: invite.email,
    name: invite.name,
    role: invite.role,
    expiresAt: invite.expiresAt,
    status: invite.status
  };
}

function normalizeAccountState(state: Partial<AccountReviewState> | undefined): AccountReviewState {
  const memos = Array.isArray(state?.memos) ? state.memos.filter(isMemoRecord) : [];
  const memoIds = new Set(memos.map((memo) => memo.id));
  const selectedMemoId = state?.selectedMemoId && memoIds.has(state.selectedMemoId)
    ? state.selectedMemoId
    : memos[0]?.id;

  return {
    memos,
    selectedMemoId,
    decisions: isRecord(state?.decisions) ? state.decisions as Record<string, ReviewerDecision> : {},
    auditEvents: Array.isArray(state?.auditEvents) ? state.auditEvents.filter(isAuditEvent) : [],
    analysisResults: isRecord(state?.analysisResults)
      ? state.analysisResults as Record<string, ReviewResult>
      : {},
    chatMessages: normalizeChatMessages(state?.chatMessages),
    outreachDrafts: isRecord(state?.outreachDrafts) ? state.outreachDrafts : {},
    discoveredLeads: Array.isArray(state?.discoveredLeads) ? state.discoveredLeads : [],
    leadSearchRuns: Array.isArray(state?.leadSearchRuns) ? state.leadSearchRuns : [],
    leadWorkflows: isRecord(state?.leadWorkflows) ? state.leadWorkflows : {},
    outreachJobs: Array.isArray(state?.outreachJobs) ? state.outreachJobs : []
  };
}

function mergeAccountState(existing: AccountReviewState, incoming: AccountReviewState): AccountReviewState {
  return {
    ...incoming,
    auditEvents: mergeById(incoming.auditEvents, existing.auditEvents),
    chatMessages: mergeChatMessages(existing.chatMessages, incoming.chatMessages),
    outreachDrafts: { ...(existing.outreachDrafts ?? {}), ...(incoming.outreachDrafts ?? {}) },
    discoveredLeads: mergeById(incoming.discoveredLeads ?? [], existing.discoveredLeads ?? []),
    leadSearchRuns: mergeById(incoming.leadSearchRuns ?? [], existing.leadSearchRuns ?? []),
    leadWorkflows: { ...(existing.leadWorkflows ?? {}), ...(incoming.leadWorkflows ?? {}) },
    outreachJobs: mergeById(incoming.outreachJobs ?? [], existing.outreachJobs ?? [])
  };
}

function mergeById<T extends { id: string }>(preferred: T[], preserved: T[]) {
  const seen = new Set<string>();
  const merged: T[] = [];
  [...preferred, ...preserved].forEach((item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    merged.push(item);
  });
  return merged;
}

function mergeChatMessages(
  existing: AccountReviewState["chatMessages"],
  incoming: AccountReviewState["chatMessages"]
) {
  const memoIds = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
  return Object.fromEntries(
    Array.from(memoIds).map((memoId) => [
      memoId,
      mergeById(incoming[memoId] ?? [], existing[memoId] ?? [])
    ])
  );
}

function cloneAccountState(state: AccountReviewState) {
  return JSON.parse(JSON.stringify(state)) as AccountReviewState;
}

function normalizeChatMessages(value: unknown) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, messages]) => Array.isArray(messages))
      .map(([memoId, messages]) => [
        memoId,
        (messages as unknown[]).filter(isMemoChatMessage)
      ])
  );
}

function isMemoRecord(value: unknown): value is MemoRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "memoText" in value &&
      typeof value.memoText === "string"
  );
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "memoId" in value &&
      typeof value.memoId === "string"
  );
}

function isMemoChatMessage(value: unknown): value is MemoChatMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "memoId" in value &&
      typeof value.memoId === "string" &&
      "text" in value &&
      typeof value.text === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new StoreError(400, "Enter a valid email address.");
  }
  return normalized;
}

function normalizeName(name: string, email: string) {
  return name.trim() || email.split("@")[0] || "Reviewer";
}

function validatePassword(password: string) {
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  if (password.length < 12 || [hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length < 3) {
    throw new StoreError(
      400,
      "Use at least 12 characters with a mix of letters, numbers, and symbols."
    );
  }
}

function hashPassword(password: string, salt: string, iterations: number) {
  return pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
}

function verifyPassword(password: string, user: UserRecord) {
  const expected = Buffer.from(user.passwordHash, "base64url");
  const actual = Buffer.from(
    hashPassword(password, user.passwordSalt, user.passwordIterations),
    "base64url"
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function isExpired(value: string) {
  return Date.parse(value) <= Date.now();
}

function toEpochSeconds(value: string) {
  return Math.floor(Date.parse(value) / 1000);
}

function readPositiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hoursToMs(hours: number) {
  return hours * 60 * 60 * 1000;
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || "http://127.0.0.1:5173").replace(/\/+$/, "");
}

function inviteLink(rawToken: string) {
  return `${appBaseUrl()}/?invite=${encodeURIComponent(rawToken)}`;
}

function resetLink(rawToken: string) {
  return `${appBaseUrl()}/?reset=${encodeURIComponent(rawToken)}`;
}

function tenantKey(tenantId: string) {
  return `TENANT#${tenantId}`;
}

function userKey(email: string) {
  return `USER#${email}`;
}

function inviteKey(tokenHash: string) {
  return `INVITE#${tokenHash}`;
}

function resetKey(tokenHash: string) {
  return `RESET#${tokenHash}`;
}

function sessionKey(tokenHash: string) {
  return `SESSION#${tokenHash}`;
}

function lockoutKey(email: string) {
  return `LOCKOUT#${email}`;
}

function usageKey(at: string, id: string) {
  return `USAGE#${at}#${id}`;
}

function rangeDaysCutoff(rangeDays?: number) {
  const days = rangeDays && rangeDays > 0 ? rangeDays : 365;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function accountKey(tenantId: string, userId: string) {
  return `TENANT#${tenantId}#USER#${userId}`;
}

function defaultStorePath() {
  if (process.env.RULIX_STORE_PATH) return process.env.RULIX_STORE_PATH;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "/tmp/rulix-store.json";
  return path.resolve(fileURLToPath(new URL("../data/rulix-store.json", import.meta.url)));
}
