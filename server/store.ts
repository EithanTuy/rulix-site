import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AccountReviewState,
  AuditEvent,
  MemoChatMessage,
  MemoRecord,
  ReviewResult,
  ReviewerDecision,
  UserProfile
} from "../src/types";

const PASSWORD_ITERATIONS = 210_000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const MAX_FAILED_ATTEMPTS = 6;
const LOCKOUT_MS = 1000 * 60 * 10;

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
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface PersistedStore {
  users: UserRecord[];
  sessions: SessionRecord[];
  accounts: Record<string, AccountReviewState>;
}

interface CreateStoreOptions {
  filePath?: string;
  persist?: boolean;
}

export interface RegisterUserInput {
  email: string;
  name: string;
  password: string;
}

export interface AuthSession {
  rawToken: string;
  csrfToken: string;
  user: UserProfile;
}

export class AccountStore {
  private readonly filePath?: string;
  private readonly persistEnabled: boolean;
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, SessionRecord>();
  private accounts = new Map<string, AccountReviewState>();

  constructor(options: CreateStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultStorePath();
    this.persistEnabled = options.persist ?? true;
    if (this.persistEnabled) {
      this.load();
    }
  }

  registerUser(input: RegisterUserInput): AuthSession {
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name, email);
    validatePassword(input.password);

    if (this.findUserByEmail(email)) {
      throw new StoreError(409, "An account already exists for that email.");
    }

    const salt = randomBytes(16).toString("base64url");
    const user: UserRecord = {
      id: `user-${randomBytes(12).toString("base64url")}`,
      email,
      name,
      role: "export-control-officer",
      createdAt: new Date().toISOString(),
      passwordHash: hashPassword(input.password, salt, PASSWORD_ITERATIONS),
      passwordSalt: salt,
      passwordIterations: PASSWORD_ITERATIONS,
      failedAttempts: 0
    };

    this.users.set(user.id, user);
    this.accounts.set(user.id, emptyAccountState());
    const session = this.createSession(user.id);
    this.persist();
    return session;
  }

  authenticate(emailInput: string, password: string): AuthSession {
    const user = this.findUserByEmail(normalizeEmail(emailInput));
    if (!user) {
      hashPassword(password || "invalid-password", randomBytes(16).toString("base64url"), PASSWORD_ITERATIONS);
      throw new StoreError(401, "Invalid email or password.");
    }

    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      throw new StoreError(429, "Too many failed sign-in attempts. Try again later.");
    }

    if (!verifyPassword(password, user)) {
      user.failedAttempts += 1;
      if (user.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
      }
      this.users.set(user.id, user);
      this.persist();
      throw new StoreError(401, "Invalid email or password.");
    }

    user.failedAttempts = 0;
    user.lockedUntil = undefined;
    this.users.set(user.id, user);
    const session = this.createSession(user.id);
    this.persist();
    return session;
  }

  getSession(rawToken: string | undefined): { user: UserProfile; session: SessionRecord } | undefined {
    if (!rawToken) return undefined;
    const tokenHash = hashToken(rawToken);
    const session = this.sessions.get(tokenHash);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= Date.now()) {
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

  destroySession(rawToken: string | undefined) {
    if (!rawToken) return;
    this.sessions.delete(hashToken(rawToken));
    this.persist();
  }

  getAccountState(userId: string): AccountReviewState {
    const current = this.accounts.get(userId) ?? emptyAccountState();
    this.accounts.set(userId, current);
    return cloneAccountState(current);
  }

  replaceAccountState(userId: string, state: AccountReviewState) {
    this.accounts.set(userId, normalizeAccountState(state));
    this.persist();
  }

  listReviews(userId: string) {
    const state = this.getAccountState(userId);
    return {
      reviews: state.memos,
      decisions: state.decisions,
      auditEvents: state.auditEvents,
      analysisResults: state.analysisResults,
      chatMessages: state.chatMessages
    };
  }

  upsertReview(userId: string, memo: MemoRecord) {
    const state = this.getAccountState(userId);
    state.memos = [memo, ...state.memos.filter((item) => item.id !== memo.id)];
    state.selectedMemoId = memo.id;
    this.replaceAccountState(userId, state);
  }

  updateReview(userId: string, memo: MemoRecord) {
    const state = this.getAccountState(userId);
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    this.replaceAccountState(userId, state);
  }

  findReview(userId: string, memoId: string) {
    return this.getAccountState(userId).memos.find((memo) => memo.id === memoId);
  }

  setAnalysisResult(userId: string, memo: MemoRecord, result: ReviewResult) {
    const state = this.getAccountState(userId);
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    state.analysisResults[result.memoId] = result;
    this.replaceAccountState(userId, state);
  }

  setDecision(userId: string, memo: MemoRecord, decision: ReviewerDecision, auditEvent: AuditEvent) {
    const state = this.getAccountState(userId);
    state.decisions[memo.id] = decision;
    state.memos = state.memos.map((item) => (item.id === memo.id ? memo : item));
    state.auditEvents = [auditEvent, ...state.auditEvents];
    this.replaceAccountState(userId, state);
  }

  appendAuditEvent(userId: string, event: AuditEvent) {
    const state = this.getAccountState(userId);
    state.auditEvents = [event, ...state.auditEvents];
    this.replaceAccountState(userId, state);
  }

  appendChatMessages(userId: string, memoId: string, messages: MemoChatMessage[]) {
    const state = this.getAccountState(userId);
    state.chatMessages[memoId] = [...(state.chatMessages[memoId] ?? []), ...messages];
    this.replaceAccountState(userId, state);
    return state.chatMessages[memoId];
  }

  private createSession(userId: string): AuthSession {
    const rawToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    const session: SessionRecord = {
      tokenHash: hashToken(rawToken),
      userId,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    };
    this.sessions.set(session.tokenHash, session);
    const user = this.users.get(userId);
    if (!user) throw new StoreError(500, "Session user was not found.");
    return { rawToken, csrfToken, user: publicUser(user) };
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedStore>;
      this.users = new Map((parsed.users ?? []).map((user) => [user.id, user]));
      this.sessions = new Map(
        (parsed.sessions ?? [])
          .filter((session) => Date.parse(session.expiresAt) > Date.now())
          .map((session) => [session.tokenHash, session])
      );
      this.accounts = new Map(
        Object.entries(parsed.accounts ?? {}).map(([userId, state]) => [
          userId,
          normalizeAccountState(state)
        ])
      );
    } catch {
      this.users = new Map();
      this.sessions = new Map();
      this.accounts = new Map();
    }
  }

  private persist() {
    if (!this.persistEnabled || !this.filePath) return;
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const payload: PersistedStore = {
      users: Array.from(this.users.values()),
      sessions: Array.from(this.sessions.values()).filter(
        (session) => Date.parse(session.expiresAt) > Date.now()
      ),
      accounts: Object.fromEntries(this.accounts.entries())
    };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  private findUserByEmail(email: string) {
    return Array.from(this.users.values()).find((user) => user.email === email);
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

export function createAccountStore(options?: CreateStoreOptions) {
  return new AccountStore(options);
}

export function emptyAccountState(): AccountReviewState {
  return {
    memos: [],
    decisions: {},
    auditEvents: [],
    analysisResults: {},
    chatMessages: {}
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
    chatMessages: normalizeChatMessages(state?.chatMessages)
  };
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

function defaultStorePath() {
  if (process.env.RULIX_STORE_PATH) return process.env.RULIX_STORE_PATH;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "/tmp/rulix-store.json";
  return path.resolve(fileURLToPath(new URL("../data/rulix-store.json", import.meta.url)));
}
