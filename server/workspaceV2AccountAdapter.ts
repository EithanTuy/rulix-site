import { randomUUID } from "node:crypto";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type {
  AccountReviewState,
  AiApprovalMemoChatFence,
  AiApprovalSubjectBinding,
  AuditEvent,
  LeadSearchRun,
  LeadWorkflow,
  MemoBuilderSession,
  MemoChatMessage,
  MemoRecord,
  MemoRevision,
  OutreachDraft,
  OutreachJob,
  OutreachLead,
  ReviewResult,
  ReviewerDecision
} from "../src/types";
import { hashMemoContent, hashReviewResult } from "./domain/hashes";
import {
  AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
  aiApprovalChatHistoryEntry,
  hashAiApprovalChatHistoryEntries,
  hashAiBuilderSession,
  type AiApprovalChatHistoryEntry
} from "./domain/aiApproval";
import type {
  AnalysisTransitionAuditEvents,
  AnalysisTransitionResult,
  AppendBoundChatCommand,
  AiMemoChatDispatchClaim,
  ApplyChatSuggestionCommand,
  ArchiveReviewCommand,
  ChatCommandResult,
  CreateReviewCommand,
  CreateReviewResult,
  CursorPage,
  DecisionExpectedBindings,
  DecisionTransitionResult,
  PageQuery,
  ReviewCommandResult,
  ReviewDetail,
  ReviewPageQuery,
  ReviewSummary,
  StoredMemoBuilderSession,
  UpdateReviewMemoCommand,
  UpdateWorkspacePreferencesCommand,
  UpsertMemoBuilderSessionCommand,
  WorkspacePreferenceRecord
} from "./store";
import {
  NormalizedWorkspaceRepository,
  WORKSPACE_ANALYSIS_MAX_BYTES,
  WORKSPACE_BUILDER_SESSION_MAX_BYTES,
  WORKSPACE_CHAT_TEXT_MAX_BYTES,
  WORKSPACE_MEMO_MAX_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceConflictError,
  WorkspaceContentGcActiveError,
  WorkspaceIntegrityError,
  WorkspaceNotFoundError,
  WorkspaceNotMigratedError,
  WorkspaceValidationError,
  assertUtf8Field,
  assertWorkspaceItemSize,
  assertWorkspaceResponseSize,
  stableCanonicalJson,
  workspacePk,
  workspaceSk,
  type WorkspaceContentRef,
  type WorkspaceContentStore,
  type WorkspaceItem,
  type WorkspaceMetaItem
} from "./workspaceV2";

type TransactionItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;

const WORKSPACE_BUILDER_ITEM_MAX_BYTES = 320 * 1024;

interface ReviewEntity extends WorkspaceItem {
  entityType: "R";
  review: Omit<MemoRecord, "memoText">;
  contentRef: WorkspaceContentRef;
  currentRevision: number;
}

interface RevisionEntity extends WorkspaceItem {
  entityType: "RV";
  revision: Omit<MemoRevision, "memoText">;
  contentRef: WorkspaceContentRef;
}

interface AnalysisEntity extends WorkspaceItem {
  entityType: "AC" | "AH";
  memoId: string;
  analysisId: string;
  analysisHash: string;
  analysisRef: WorkspaceContentRef;
}

interface DecisionEntity extends WorkspaceItem {
  entityType: "DC";
  memoId: string;
  decision: ReviewerDecision;
}

interface ChatEntity extends WorkspaceItem {
  entityType: "CH";
  message: Omit<MemoChatMessage, "proposedMemoText">;
  messageSequence: number;
  proposedMemoRef?: WorkspaceContentRef;
}

interface ChatMetaEntity extends WorkspaceItem {
  entityType: "CHAT_META";
  memoId: string;
  nextSequence: number;
  historySchemaVersion: typeof AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION;
  historyWindow: AiApprovalChatHistoryEntry[];
  historyHash: string;
  aiDispatchClaim?: AiMemoChatDispatchClaim;
}

export interface AiApprovalChatFenceCapture {
  fence: AiApprovalMemoChatFence;
  condition: TransactionItems[number];
}

interface BuilderEntity extends WorkspaceItem {
  entityType: "BS";
  session: MemoBuilderSession;
}

interface OutreachEntity<T> extends WorkspaceItem {
  value: T;
}

interface IdempotencyEntity extends WorkspaceItem {
  entityType: "IC";
  requestId: string;
  inputHash: string;
  memoId: string;
}

export interface WorkspaceStateTransitions {
  create(state: AccountReviewState, userId: string, command: CreateReviewCommand): CreateReviewResult;
  updateMemo(
    state: AccountReviewState,
    userId: string,
    memoId: string,
    command: UpdateReviewMemoCommand
  ): ReviewCommandResult;
  archive(
    state: AccountReviewState,
    memoId: string,
    command: ArchiveReviewCommand
  ): ReviewCommandResult;
  appendChat(
    state: AccountReviewState,
    memoId: string,
    command: AppendBoundChatCommand
  ): ChatCommandResult;
  applySuggestion(
    state: AccountReviewState,
    userId: string,
    memoId: string,
    command: ApplyChatSuggestionCommand
  ): ChatCommandResult;
  analysis(
    state: AccountReviewState,
    userId: string,
    memo: MemoRecord,
    result: ReviewResult,
    auditEvents?: AnalysisTransitionAuditEvents
  ): AnalysisTransitionResult;
  decision(
    state: AccountReviewState,
    userId: string,
    memoId: string,
    decision: ReviewerDecision,
    auditEvent: AuditEvent,
    expected: DecisionExpectedBindings
  ): DecisionTransitionResult;
}

export class NormalizedWorkspaceAccountAdapter {
  constructor(
    readonly repository: NormalizedWorkspaceRepository,
    private readonly content: WorkspaceContentStore,
    private readonly transitions: WorkspaceStateTransitions,
    private readonly now: () => Date = () => new Date()
  ) {}

  async initializeWorkspace(userId: string) {
    await this.repository.transact([this.newAccountWorkspacePut(userId)]);
  }

  newAccountWorkspacePut(userId: string): TransactionItems[number] {
    const now = this.now().toISOString();
    const item: WorkspaceMetaItem = {
      pk: workspacePk(this.repository.tenantId, userId),
      sk: workspaceSk.meta(),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "META",
      entityVersion: 0,
      migrationStatus: "complete",
      sourceDigest: "new-account",
      migratedAt: now,
      builderSessionCount: 0,
      createdAt: now,
      updatedAt: now
    };
    return immutablePut(this.repository.tableName, item);
  }

  async listReviews(userId: string, query: ReviewPageQuery): Promise<CursorPage<ReviewSummary>> {
    await this.repository.requireMigrated(userId);
    const pk = workspacePk(this.repository.tenantId, userId);
    const byState = query.state !== "all";
    const page = await this.repository.queryPage<ReviewEntity>({
      userId,
      prefix: "R#",
      limit: Math.min(query.limit, 100),
      maxLimit: 100,
      cursor: query.cursor,
      forward: false,
      indexName: byState ? "gsi2" : "gsi1",
      indexPk: byState
        ? `${pk}#REVIEWS#${query.state === "archived" ? "ARCHIVED" : "ACTIVE"}`
        : `${pk}#REVIEWS`,
      indexPartitionAttribute: byState ? "gsi2pk" : "gsi1pk",
      indexSortAttribute: byState ? "gsi2sk" : "gsi1sk"
    });
    return responsePage(page.items.map((item) => reviewSummary(item.review)), page.nextCursor);
  }

  async getReviewDetail(userId: string, memoId: string): Promise<ReviewDetail | undefined> {
    await this.repository.requireMigrated(userId);
    const [reviewEntity, analysisEntity, decisionEntity] = await Promise.all([
      this.reviewEntity(userId, memoId),
      this.repository.getItem<AnalysisEntity>(userId, workspaceSk.analysisCurrent(memoId)),
      this.repository.getItem<DecisionEntity>(userId, workspaceSk.decision(memoId))
    ]);
    if (!reviewEntity) return undefined;
    const [review, result] = await Promise.all([
      this.hydrateReview(userId, reviewEntity),
      analysisEntity ? this.hydrateAnalysis(userId, analysisEntity) : undefined
    ]);
    return {
      review,
      ...(result ? { result } : {}),
      ...(decisionEntity?.decision ? { decision: structuredClone(decisionEntity.decision) } : {})
    };
  }

  /** Strongly loads and returns the exact Dynamo condition used when an AI
   * approval is minted, so approval creation cannot race a review edit. */
  async aiApprovalReviewCondition(
    userId: string,
    subject: AiApprovalSubjectBinding
  ): Promise<TransactionItems[number]> {
    await this.repository.requireMigrated(userId);
    if (subject.kind !== "review" || subject.revision === undefined) {
      throw new WorkspaceValidationError("Review approval binding is invalid.");
    }
    const entity = await this.requireReviewEntity(userId, subject.id);
    const review = await this.hydrateReview(userId, entity);
    const revision = review.revision ?? 1;
    const version = review.version ?? revision;
    const contentHash = review.contentHash ?? hashMemoContent(review);
    if (version !== subject.version || revision !== subject.revision || contentHash !== subject.contentHash) {
      throw new WorkspaceConflictError("Review changed before AI approval was recorded.");
    }
    return {
      ConditionCheck: {
        TableName: this.repository.tableName,
        Key: { pk: entity.pk, sk: entity.sk },
        ConditionExpression:
          "#entityVersion = :version AND #currentRevision = :revision AND #review.#contentHash = :contentHash",
        ExpressionAttributeNames: {
          "#entityVersion": "entityVersion",
          "#currentRevision": "currentRevision",
          "#review": "review",
          "#contentHash": "contentHash"
        },
        ExpressionAttributeValues: {
          ":version": subject.version,
          ":revision": subject.revision,
          ":contentHash": subject.contentHash
        }
      }
    };
  }

  /** Equivalent CAS binding for a persisted memo-builder session. */
  async aiApprovalBuilderCondition(
    userId: string,
    subject: AiApprovalSubjectBinding
  ): Promise<TransactionItems[number]> {
    await this.repository.requireMigrated(userId);
    if (subject.kind !== "memo-builder") {
      throw new WorkspaceValidationError("Memo-builder approval binding is invalid.");
    }
    const entity = await this.repository.getItem<BuilderEntity>(userId, workspaceSk.builderSession(subject.id), true);
    if (!entity) throw new WorkspaceNotFoundError("Memo-builder session not found.");
    const contentHash = hashAiBuilderSession(entity.session);
    if (entity.entityVersion !== subject.version || contentHash !== subject.contentHash) {
      throw new WorkspaceConflictError("Memo-builder session changed before AI approval was recorded.");
    }
    return {
      ConditionCheck: {
        TableName: this.repository.tableName,
        Key: { pk: entity.pk, sk: entity.sk },
        ConditionExpression: "#entityVersion = :version",
        ExpressionAttributeNames: { "#entityVersion": "entityVersion" },
        ExpressionAttributeValues: { ":version": subject.version }
      }
    };
  }

  /** Binds the exact latest chat window and its append-only sequence fence. */
  async aiApprovalChatCondition(
    userId: string,
    memoId: string,
    historyHash: string
  ): Promise<AiApprovalChatFenceCapture> {
    await this.repository.requireMigrated(userId);
    const meta = await this.repository.getItem<ChatMetaEntity>(userId, workspaceSk.chatMeta(memoId), true);
    const fence = authoritativeChatFence(meta);
    if (fence.historyHash !== historyHash) {
      throw new WorkspaceConflictError("Memo-chat history changed before AI approval was recorded.");
    }
    return {
      fence,
      condition: this.aiApprovalChatFenceCondition(userId, memoId, fence)
    };
  }

  aiApprovalChatFenceCondition(
    userId: string,
    memoId: string,
    fence: AiApprovalMemoChatFence
  ): TransactionItems[number] {
    return chatFenceCondition(
      this.repository.tableName,
      workspacePk(this.repository.tenantId, userId),
      workspaceSk.chatMeta(memoId),
      fence
    );
  }

  aiApprovalChatClaimTransition(
    userId: string,
    memoId: string,
    fence: AiApprovalMemoChatFence,
    claim: AiMemoChatDispatchClaim,
    now: string,
    nowEpoch: number
  ): TransactionItems[number] {
    const pk = workspacePk(this.repository.tenantId, userId);
    const sk = workspaceSk.chatMeta(memoId);
    const durableClaim: AiMemoChatDispatchClaim = {
      dispatchId: claim.dispatchId,
      requestHash: claim.requestHash,
      reservationToken: claim.reservationToken,
      expiresAtEpoch: claim.expiresAtEpoch
    };
    if (!fence.chatMeta.exists) {
      const item: ChatMetaEntity = {
        pk,
        sk,
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        entityType: "CHAT_META",
        entityVersion: 1,
        memoId,
        nextSequence: 0,
        historySchemaVersion: AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
        historyWindow: [],
        historyHash: hashAiApprovalChatHistoryEntries([]),
        aiDispatchClaim: durableClaim,
        createdAt: now,
        updatedAt: now
      };
      return {
        Put: {
          TableName: this.repository.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" }
        }
      };
    }
    return {
      Update: {
        TableName: this.repository.tableName,
        Key: { pk, sk },
        UpdateExpression: "SET #aiDispatchClaim = :claim, #updatedAt = :updatedAt",
        ConditionExpression: [
          "#entityVersion = :version",
          "#nextSequence = :nextSequence",
          "#historyHash = :historyHash",
          "#historySchemaVersion = :historySchemaVersion",
          "(attribute_not_exists(#aiDispatchClaim) OR #aiDispatchClaim.#expiresAtEpoch <= :nowEpoch)"
        ].join(" AND "),
        ExpressionAttributeNames: {
          "#entityVersion": "entityVersion",
          "#nextSequence": "nextSequence",
          "#historyHash": "historyHash",
          "#historySchemaVersion": "historySchemaVersion",
          "#aiDispatchClaim": "aiDispatchClaim",
          "#expiresAtEpoch": "expiresAtEpoch",
          "#updatedAt": "updatedAt"
        },
        ExpressionAttributeValues: {
          ":version": fence.chatMeta.entityVersion,
          ":nextSequence": fence.chatMeta.nextSequence,
          ":historyHash": fence.historyHash,
          ":historySchemaVersion": AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
          ":claim": durableClaim,
          ":updatedAt": now,
          ":nowEpoch": nowEpoch
        }
      }
    };
  }

  aiApprovalChatClaimRelease(
    userId: string,
    memoId: string,
    fence: AiApprovalMemoChatFence,
    claim: Pick<AiMemoChatDispatchClaim, "dispatchId" | "requestHash" | "reservationToken">,
    now: string
  ): TransactionItems[number] {
    const key = {
      pk: workspacePk(this.repository.tenantId, userId),
      sk: workspaceSk.chatMeta(memoId)
    };
    const names = {
      "#aiDispatchClaim": "aiDispatchClaim",
      "#dispatchId": "dispatchId",
      "#requestHash": "requestHash",
      "#reservationToken": "reservationToken"
    };
    const values = {
      ":dispatchId": claim.dispatchId,
      ":requestHash": claim.requestHash,
      ":reservationToken": claim.reservationToken
    };
    const condition = [
      "#aiDispatchClaim.#dispatchId = :dispatchId",
      "#aiDispatchClaim.#requestHash = :requestHash",
      "#aiDispatchClaim.#reservationToken = :reservationToken"
    ].join(" AND ");
    if (!fence.chatMeta.exists) {
      return {
        Delete: {
          TableName: this.repository.tableName,
          Key: key,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values
        }
      };
    }
    return {
      Update: {
        TableName: this.repository.tableName,
        Key: key,
        UpdateExpression: "REMOVE #aiDispatchClaim SET #updatedAt = :updatedAt",
        ConditionExpression: condition,
        ExpressionAttributeNames: {
          ...names,
          "#updatedAt": "updatedAt"
        },
        ExpressionAttributeValues: {
          ...values,
          ":updatedAt": now
        }
      }
    };
  }

  async listReviewAuditEvents(userId: string, memoId: string, query: PageQuery) {
    await this.repository.requireMigrated(userId);
    const page = await this.repository.queryPage<WorkspaceItem>({
      userId,
      prefix: `AU#${keyPrefix(memoId)}#`,
      limit: Math.min(query.limit, 200),
      maxLimit: 200,
      cursor: query.cursor,
      forward: false
    });
    const events = page.items.map((item) => {
      if (!item.auditEvent || typeof item.auditEvent !== "object") {
        throw new WorkspaceIntegrityError(`Audit outbox ${item.sk} is missing its event.`);
      }
      return structuredClone(item.auditEvent as AuditEvent);
    });
    return responsePage(events, page.nextCursor);
  }

  async listReviewChatMessages(userId: string, memoId: string, query: PageQuery) {
    await this.repository.requireMigrated(userId);
    const pk = workspacePk(this.repository.tenantId, userId);
    const page = await this.repository.queryPage<ChatEntity>({
      userId,
      prefix: "CH#",
      limit: Math.min(query.limit, 200),
      maxLimit: 200,
      cursor: query.cursor,
      forward: false,
      indexName: "gsi1",
      indexPk: `${pk}#CHAT#${keyPrefix(memoId)}`
    });
    const messages = await Promise.all(page.items.map((item) => this.hydrateChat(userId, item)));
    return responsePage(messages, page.nextCursor);
  }

  async createReviewIdempotent(userId: string, command: CreateReviewCommand) {
    await this.repository.requireMigrated(userId);
    const receiptKey = workspaceSk.idempotency(command.requestId);
    const existing = await this.repository.getItem<IdempotencyEntity>(userId, receiptKey);
    if (existing) {
      if (existing.inputHash !== command.inputHash) {
        throw new WorkspaceConflictError("This request ID was already used for different review content.");
      }
      const detail = await this.getReviewDetail(userId, existing.memoId);
      if (!detail) throw new WorkspaceIntegrityError("Idempotency receipt points to a missing review.");
      return { review: detail.review, auditEvents: [], replayed: true } satisfies CreateReviewResult;
    }

    const state = emptyTransitionState();
    const transition = this.transitions.create(state, userId, command);
    const review = transition.review;
    const revision = state.memoRevisions?.[review.id]?.[0];
    if (!revision) throw new WorkspaceIntegrityError("Create transition did not produce an initial revision.");
    const contentRef = await this.putMemoRevision(userId, revision);
    const now = this.now().toISOString();
    const reviewItem = reviewEntityItem(this.repository.tenantId, userId, review, contentRef, now);
    const revisionItem = revisionEntityItem(this.repository.tenantId, userId, revision, contentRef);
    const receipt: WorkspaceItem = {
      pk: reviewItem.pk,
      sk: receiptKey,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "IC",
      entityVersion: 1,
      requestId: command.requestId,
      inputHash: command.inputHash,
      memoId: review.id,
      expiresAt: Math.floor(this.now().getTime() / 1000) + 30 * 86_400,
      createdAt: now,
      updatedAt: now
    };
    try {
      await this.repository.transact([
        metaReadyCheck(this.repository.tableName, reviewItem.pk),
        immutablePut(this.repository.tableName, reviewItem),
        immutablePut(this.repository.tableName, revisionItem),
        immutablePut(this.repository.tableName, receipt),
        this.repository.outboxPut(userId, command.auditEvent)
      ]);
    } catch (error) {
      if (!(error instanceof WorkspaceConflictError)) throw error;

      // Two identical requests can both miss the receipt before one transaction
      // wins. Resolve that race from the strongly consistent receipt instead of
      // turning a successful idempotent create into a spurious conflict.
      const winner = await this.repository.getItem<IdempotencyEntity>(userId, receiptKey, true);
      if (!winner) throw error;
      if (winner.inputHash !== command.inputHash) {
        throw new WorkspaceConflictError("This request ID was already used for different review content.");
      }
      const detail = await this.getReviewDetail(userId, winner.memoId);
      if (!detail) throw new WorkspaceIntegrityError("Idempotency receipt points to a missing review.");
      return { review: detail.review, auditEvents: [], replayed: true } satisfies CreateReviewResult;
    }
    return { review, auditEvents: [structuredClone(command.auditEvent)], replayed: false };
  }

  async updateReviewMemo(userId: string, memoId: string, command: UpdateReviewMemoCommand) {
    await this.repository.requireMigrated(userId);
    const currentEntity = await this.requireReviewEntity(userId, memoId);
    const current = await this.hydrateReview(userId, currentEntity);
    const state = transitionState(current);
    const transition = this.transitions.updateMemo(state, userId, memoId, command);
    const revision = state.memoRevisions?.[memoId]?.[0];
    if (!revision) throw new WorkspaceIntegrityError("Memo update did not produce a revision.");
    const contentRef = await this.putMemoRevision(userId, revision);
    const nextItem = reviewEntityItem(
      this.repository.tenantId, userId, transition.review, contentRef, currentEntity.createdAt
    );
    const revisionItem = revisionEntityItem(this.repository.tenantId, userId, revision, contentRef);
    await this.repository.transact([
      casReviewPut(this.repository.tableName, nextItem, command),
      immutablePut(this.repository.tableName, revisionItem),
      deleteItem(this.repository.tableName, nextItem.pk, workspaceSk.analysisCurrent(memoId)),
      deleteItem(this.repository.tableName, nextItem.pk, workspaceSk.decision(memoId)),
      this.repository.outboxPut(userId, command.auditEvent)
    ]);
    return { review: transition.review, auditEvents: [structuredClone(command.auditEvent)] };
  }

  async setReviewArchived(userId: string, memoId: string, command: ArchiveReviewCommand) {
    await this.repository.requireMigrated(userId);
    const currentEntity = await this.requireReviewEntity(userId, memoId);
    const current = await this.hydrateReview(userId, currentEntity);
    const state = transitionState(current);
    const transition = this.transitions.archive(state, memoId, command);
    const nextItem = reviewEntityItem(
      this.repository.tenantId, userId, transition.review, currentEntity.contentRef, currentEntity.createdAt
    );
    await this.repository.transact([
      casReviewPut(this.repository.tableName, nextItem, command),
      this.repository.outboxPut(userId, command.auditEvent)
    ]);
    return { review: transition.review, auditEvents: [structuredClone(command.auditEvent)] };
  }

  async appendBoundChat(userId: string, memoId: string, command: AppendBoundChatCommand) {
    await this.repository.requireMigrated(userId);
    if (command.messages.length < 1 || command.messages.length > 20) {
      throw new WorkspaceValidationError("Chat append must contain 1-20 messages.");
    }
    const currentEntity = await this.requireReviewEntity(userId, memoId);
    const chatMeta = await this.repository.getItem<ChatMetaEntity>(
      userId,
      workspaceSk.chatMeta(memoId),
      true
    );
    const currentChatFence = authoritativeChatFence(chatMeta);
    const now = this.now();
    assertChatAppendClaim(
      chatMeta?.aiDispatchClaim,
      command.aiDispatchClaim,
      currentChatFence,
      Math.floor(now.getTime() / 1_000)
    );
    const current = await this.hydrateReview(userId, currentEntity);
    const state = transitionState(current);
    this.transitions.appendChat(state, memoId, command);
    const firstSequence = chatMeta?.nextSequence ?? 0;
    const chatItems = await Promise.all(command.messages.map(
      (message, index) => this.chatItem(userId, message, firstSequence + index)
    ));
    const nextChatMeta = chatMetaItem(
      this.repository.tenantId,
      userId,
      memoId,
      firstSequence + command.messages.length,
      chatMeta,
      command.messages,
      now.toISOString()
    );
    const transaction: TransactionItems = [
      reviewBindingCheck(this.repository.tableName, currentEntity.pk, memoId, command),
      chatMeta
        ? chatMetaAppendPut(
            this.repository.tableName,
            nextChatMeta,
            chatMeta,
            command.aiDispatchClaim,
            Math.floor(now.getTime() / 1_000)
          )
        : immutablePut(this.repository.tableName, nextChatMeta),
      ...chatItems.map((item) => immutablePut(this.repository.tableName, item))
    ];
    if (command.auditEvent) transaction.push(this.repository.outboxPut(userId, command.auditEvent));
    await this.repository.transact(transaction);
    const messages = (await this.listReviewChatMessages(userId, memoId, { limit: 200 })).items;
    return {
      review: current,
      messages,
      auditEvents: command.auditEvent ? [structuredClone(command.auditEvent)] : []
    };
  }

  async applyChatSuggestion(userId: string, memoId: string, command: ApplyChatSuggestionCommand) {
    await this.repository.requireMigrated(userId);
    const [currentEntity, suggestionEntity, chatMeta] = await Promise.all([
      this.requireReviewEntity(userId, memoId),
      this.repository.getItem<ChatEntity>(userId, workspaceSk.chat(memoId, command.messageId)),
      this.repository.getItem<ChatMetaEntity>(userId, workspaceSk.chatMeta(memoId), true)
    ]);
    if (!suggestionEntity) throw new WorkspaceNotFoundError("Chat suggestion not found.");
    if (!chatMeta) throw new WorkspaceIntegrityError("Chat metadata is missing for a stored suggestion.");
    authoritativeChatFence(chatMeta);
    assertNoLiveChatClaim(chatMeta.aiDispatchClaim, Math.floor(this.now().getTime() / 1_000));
    const [current, suggestion] = await Promise.all([
      this.hydrateReview(userId, currentEntity),
      this.hydrateChat(userId, suggestionEntity)
    ]);
    const state = transitionState(current, { chatMessages: { [memoId]: [suggestion] } });
    const transition = this.transitions.applySuggestion(state, userId, memoId, command);
    const revision = state.memoRevisions?.[memoId]?.[0];
    if (!revision) throw new WorkspaceIntegrityError("Suggestion apply did not produce a revision.");
    const contentRef = await this.putMemoRevision(userId, revision);
    const nextReview = reviewEntityItem(
      this.repository.tenantId, userId, transition.review, contentRef, currentEntity.createdAt
    );
    const nextSuggestion: ChatEntity = {
      ...suggestionEntity,
      entityVersion: (suggestionEntity.entityVersion ?? 1) + 1,
      message: { ...suggestionEntity.message, applied: true },
      updatedAt: this.now().toISOString()
    };
    const nextHistoryMessage: MemoChatMessage = { ...suggestion, applied: true };
    const nextChatMeta = chatMetaAfterSuggestion(chatMeta, nextHistoryMessage, this.now().toISOString());
    await this.repository.transact([
      casReviewPut(this.repository.tableName, nextReview, {
        expectedVersion: command.expectedVersion,
        expectedRevision: current.revision ?? 1,
        expectedHash: command.expectedHash
      }),
      immutablePut(this.repository.tableName, revisionEntityItem(
        this.repository.tenantId, userId, revision, contentRef
      )),
      casEntityPut(this.repository.tableName, nextSuggestion, suggestionEntity.entityVersion ?? 1),
      casEntityPut(this.repository.tableName, nextChatMeta, chatMeta.entityVersion!),
      deleteItem(this.repository.tableName, nextReview.pk, workspaceSk.analysisCurrent(memoId)),
      deleteItem(this.repository.tableName, nextReview.pk, workspaceSk.decision(memoId)),
      this.repository.outboxPut(userId, command.auditEvent)
    ]);
    const messages = (await this.listReviewChatMessages(userId, memoId, { limit: 200 })).items;
    return { review: transition.review, messages, auditEvents: [structuredClone(command.auditEvent)] };
  }

  async getWorkspacePreferences(userId: string): Promise<WorkspacePreferenceRecord> {
    const meta = await this.repository.requireMigrated(userId);
    return {
      version: meta.entityVersion,
      ...(meta.selectedMemoId ? { selectedMemoId: meta.selectedMemoId } : {}),
      ...(meta.activeMemoBuilderSessionId
        ? { activeMemoBuilderSessionId: meta.activeMemoBuilderSessionId }
        : {})
    };
  }

  async updateWorkspacePreferences(userId: string, command: UpdateWorkspacePreferencesCommand) {
    const meta = await this.repository.requireMigrated(userId);
    if (meta.entityVersion !== command.expectedVersion) {
      throw new WorkspaceConflictError("Workspace preferences changed in another session.");
    }
    const next: WorkspaceMetaItem = {
      ...meta,
      entityVersion: meta.entityVersion + 1,
      updatedAt: this.now().toISOString()
    };
    if (command.selectedMemoId !== undefined) {
      if (command.selectedMemoId) next.selectedMemoId = command.selectedMemoId;
      else delete next.selectedMemoId;
    }
    if (command.activeMemoBuilderSessionId !== undefined) {
      if (command.activeMemoBuilderSessionId) {
        next.activeMemoBuilderSessionId = command.activeMemoBuilderSessionId;
      } else {
        delete next.activeMemoBuilderSessionId;
      }
    }
    assertWorkspaceItemSize(next, 32 * 1024);
    await this.repository.transact([
      casEntityPut(this.repository.tableName, next, command.expectedVersion, true)
    ]);
    return this.getWorkspacePreferences(userId);
  }

  async listMemoBuilderSessions(userId: string, query: PageQuery) {
    await this.repository.requireMigrated(userId);
    const pk = workspacePk(this.repository.tenantId, userId);
    const page = await this.repository.queryPage<BuilderEntity>({
      userId,
      prefix: "BS#",
      limit: Math.min(query.limit, 50),
      maxLimit: 50,
      cursor: query.cursor,
      forward: false,
      indexName: "gsi1",
      indexPk: `${pk}#BUILDERS`
    });
    return responsePage(page.items.map((item) => ({
      session: structuredClone(item.session),
      version: item.entityVersion ?? 1
    })), page.nextCursor);
  }

  async upsertMemoBuilderSession(
    userId: string,
    sessionId: string,
    command: UpsertMemoBuilderSessionCommand
  ): Promise<StoredMemoBuilderSession> {
    const meta = await this.repository.requireMigrated(userId);
    if (sessionId !== command.session.id) {
      throw new WorkspaceValidationError("Memo Builder session ID does not match the route.");
    }
    validateBuilderSession(command.session);
    const existing = await this.repository.getItem<BuilderEntity>(
      userId, workspaceSk.builderSession(sessionId)
    );
    const currentVersion = existing?.entityVersion ?? 0;
    if (currentVersion !== command.expectedVersion) {
      throw new WorkspaceConflictError("Memo Builder session changed in another tab.");
    }
    const now = this.now().toISOString();
    const pk = workspacePk(this.repository.tenantId, userId);
    const item: BuilderEntity = {
      pk,
      sk: workspaceSk.builderSession(sessionId),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "BS",
      entityVersion: currentVersion + 1,
      session: structuredClone(command.session),
      gsi1pk: `${pk}#BUILDERS`,
      gsi1sk: `BS#${command.session.updatedAt}#${sessionId}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    assertWorkspaceItemSize(item, WORKSPACE_BUILDER_ITEM_MAX_BYTES);
    const transaction: TransactionItems = [
      existing
        ? casEntityPut(this.repository.tableName, item, currentVersion)
        : immutablePut(this.repository.tableName, item)
    ];
    if (!existing) transaction.push(builderCountUpdate(this.repository.tableName, meta.pk, 1, now));
    await this.repository.transact(transaction);
    return { session: structuredClone(command.session), version: item.entityVersion ?? 1 };
  }

  async deleteMemoBuilderSession(userId: string, sessionId: string, expectedVersion: number) {
    const meta = await this.repository.requireMigrated(userId);
    const existing = await this.repository.getItem<BuilderEntity>(
      userId, workspaceSk.builderSession(sessionId)
    );
    if (!existing) return;
    if ((existing.entityVersion ?? 1) !== expectedVersion) {
      throw new WorkspaceConflictError("Memo Builder session changed in another tab.");
    }
    await this.repository.transact([
      conditionalDelete(this.repository.tableName, existing.pk, existing.sk, expectedVersion),
      builderCountUpdate(this.repository.tableName, meta.pk, -1, this.now().toISOString())
    ]);
  }

  async listOutreachLeadsPage(userId: string, query: PageQuery) {
    return this.listOutreachValuesPage<OutreachLead>(userId, "LEAD", query);
  }

  async listOutreachLeads(userId: string) {
    return this.listOutreachValues<OutreachLead>(userId, "LEAD", 1000);
  }

  async getOutreachLead(userId: string, leadId: string) {
    return this.getOutreachValue<OutreachLead>(userId, "LEAD", leadId);
  }

  async upsertOutreachLeads(userId: string, leads: OutreachLead[]) {
    await this.repository.requireMigrated(userId);
    if (leads.length > 100) throw new WorkspaceValidationError("At most 100 outreach leads may be upserted at once.");
    for (const batch of chunk(leads, 25)) {
      await this.repository.transact(batch.map((lead) => this.outreachPut(
        userId, "LEAD", lead.leadId, lead, lead.discoveredAt
      )));
    }
  }

  async listOutreachDraftsPage(userId: string, query: PageQuery) {
    return this.listOutreachValuesPage<OutreachDraft>(userId, "DRAFT", query);
  }

  async listOutreachDrafts(userId: string) {
    const drafts = await this.listOutreachValues<OutreachDraft>(userId, "DRAFT", 1000);
    return Object.fromEntries(drafts.map((draft) => [draft.leadId, draft]));
  }

  async getOutreachDraft(userId: string, leadId: string) {
    return this.getOutreachValue<OutreachDraft>(userId, "DRAFT", leadId);
  }

  async upsertOutreachDraft(userId: string, draft: OutreachDraft, expectedUpdatedAt?: string) {
    await this.upsertOutreachValue(userId, "DRAFT", draft.leadId, draft, draft.updatedAt, expectedUpdatedAt);
  }

  async listLeadSearchRunsPage(userId: string, query: PageQuery) {
    return this.listOutreachValuesPage<LeadSearchRun>(userId, "RUN", query);
  }

  async listLeadSearchRuns(userId: string) {
    return this.listOutreachValues<LeadSearchRun>(userId, "RUN", 500);
  }

  async appendLeadSearchRun(userId: string, run: LeadSearchRun) {
    await this.repository.requireMigrated(userId);
    const item = this.outreachItem(userId, "RUN", run.id, run, run.completedAt);
    await this.repository.transact([immutablePut(this.repository.tableName, item)]);
  }

  async listLeadWorkflowsPage(userId: string, query: PageQuery) {
    return this.listOutreachValuesPage<LeadWorkflow>(userId, "WORKFLOW", query);
  }

  async listLeadWorkflows(userId: string) {
    const workflows = await this.listOutreachValues<LeadWorkflow>(userId, "WORKFLOW", 1000);
    return Object.fromEntries(workflows.map((workflow) => [workflow.leadId, workflow]));
  }

  async getLeadWorkflow(userId: string, leadId: string) {
    return this.getOutreachValue<LeadWorkflow>(userId, "WORKFLOW", leadId);
  }

  async upsertLeadWorkflow(userId: string, workflow: LeadWorkflow, expectedUpdatedAt?: string) {
    await this.upsertOutreachValue(
      userId, "WORKFLOW", workflow.leadId, workflow, workflow.updatedAt, expectedUpdatedAt
    );
  }

  async listOutreachJobsPage(userId: string, query: PageQuery) {
    return this.listOutreachValuesPage<OutreachJob>(userId, "JOB", query);
  }

  async listOutreachJobs(userId: string) {
    return this.listOutreachValues<OutreachJob>(userId, "JOB", 500);
  }

  async getOutreachJob(userId: string, jobId: string) {
    return this.getOutreachValue<OutreachJob>(userId, "JOB", jobId);
  }

  async upsertOutreachJob(userId: string, job: OutreachJob, expectedUpdatedAt?: string) {
    await this.upsertOutreachValue(userId, "JOB", job.id, job, job.updatedAt, expectedUpdatedAt);
  }

  async setAnalysisResult(
    userId: string,
    memo: MemoRecord,
    result: ReviewResult,
    auditEvents?: AnalysisTransitionAuditEvents
  ) {
    await this.repository.requireMigrated(userId);
    const [reviewEntity, analysisEntity, decisionEntity] = await Promise.all([
      this.requireReviewEntity(userId, memo.id),
      this.repository.getItem<AnalysisEntity>(userId, workspaceSk.analysisCurrent(memo.id)),
      this.repository.getItem<DecisionEntity>(userId, workspaceSk.decision(memo.id))
    ]);
    const [current, previousResult] = await Promise.all([
      this.hydrateReview(userId, reviewEntity),
      analysisEntity ? this.hydrateAnalysis(userId, analysisEntity) : undefined
    ]);
    const state = transitionState(current, {
      analysisResults: previousResult ? { [memo.id]: previousResult } : {},
      decisions: decisionEntity ? { [memo.id]: decisionEntity.decision } : {}
    });
    const transition = this.transitions.analysis(state, userId, memo, result, auditEvents);
    const resultText = stableCanonicalJson(transition.result);
    const analysisId = transition.result.id;
    const analysisHash = transition.result.resultHash ?? hashReviewResult(transition.result);
    if (!analysisId) throw new WorkspaceIntegrityError("Analysis transition did not bind an analysis ID.");
    const analysisRef = await this.content.putImmutable({
      tenantId: this.repository.tenantId,
      userId,
      entity: "analysis",
      id: `${memo.id}/${analysisId}`,
      body: resultText,
      mimeType: "application/json",
      maxBytes: WORKSPACE_ANALYSIS_MAX_BYTES
    });
    const now = this.now().toISOString();
    const nextReview = reviewEntityItem(
      this.repository.tenantId, userId, transition.review, reviewEntity.contentRef, reviewEntity.createdAt
    );
    const currentAnalysisVersion = analysisEntity?.entityVersion ?? 0;
    const analysisBase = {
      pk: nextReview.pk,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      memoId: memo.id,
      analysisId,
      analysisHash,
      analysisRef,
      summary: analysisSummary(transition.result),
      createdAt: transition.result.generatedAt,
      updatedAt: now
    };
    const currentAnalysis: AnalysisEntity = {
      ...analysisBase,
      sk: workspaceSk.analysisCurrent(memo.id),
      entityType: "AC",
      entityVersion: currentAnalysisVersion + 1
    };
    const history: AnalysisEntity = {
      ...analysisBase,
      sk: workspaceSk.analysisHistory(memo.id, analysisId),
      entityType: "AH",
      entityVersion: 1
    };
    const transaction: TransactionItems = [
      casReviewPut(this.repository.tableName, nextReview, {
        expectedVersion: current.version ?? current.revision ?? 1,
        expectedRevision: current.revision ?? 1,
        expectedHash: current.contentHash ?? hashMemoContent(current)
      }),
      analysisEntity
        ? casEntityPut(this.repository.tableName, currentAnalysis, currentAnalysisVersion)
        : immutablePut(this.repository.tableName, currentAnalysis),
      immutablePut(this.repository.tableName, history)
    ];
    if (transition.decisionInvalidated) {
      transaction.push(deleteItem(this.repository.tableName, nextReview.pk, workspaceSk.decision(memo.id)));
    }
    for (const event of transition.auditEvents) transaction.push(this.repository.outboxPut(userId, event));
    await this.repository.transact(transaction);
    return {
      ...transition,
      auditEvents: transition.auditEvents.map((event) => structuredClone(event))
    };
  }

  async setDecision(
    userId: string,
    memoId: string,
    decision: ReviewerDecision,
    auditEvent: AuditEvent,
    expected: DecisionExpectedBindings
  ) {
    await this.repository.requireMigrated(userId);
    const [reviewEntity, analysisEntity, decisionEntity] = await Promise.all([
      this.requireReviewEntity(userId, memoId),
      this.repository.getItem<AnalysisEntity>(userId, workspaceSk.analysisCurrent(memoId)),
      this.repository.getItem<DecisionEntity>(userId, workspaceSk.decision(memoId))
    ]);
    if (!analysisEntity) throw new WorkspaceConflictError("The bound analysis is unavailable.");
    const [review, result] = await Promise.all([
      this.hydrateReview(userId, reviewEntity),
      this.hydrateAnalysis(userId, analysisEntity)
    ]);
    const state = transitionState(review, {
      analysisResults: { [memoId]: result },
      decisions: decisionEntity ? { [memoId]: decisionEntity.decision } : {}
    });
    const transition = this.transitions.decision(
      state, userId, memoId, decision, auditEvent, expected
    );
    const nextReview = reviewEntityItem(
      this.repository.tenantId, userId, transition.review, reviewEntity.contentRef, reviewEntity.createdAt
    );
    const decisionVersion = decisionEntity?.entityVersion ?? 0;
    const now = this.now().toISOString();
    const decisionItem: DecisionEntity = {
      pk: nextReview.pk,
      sk: workspaceSk.decision(memoId),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "DC",
      entityVersion: decisionVersion + 1,
      memoId,
      decision: structuredClone(transition.decision),
      createdAt: decisionEntity?.createdAt ?? now,
      updatedAt: now
    };
    assertWorkspaceItemSize(decisionItem, 32 * 1024);
    await this.repository.transact([
      casReviewPut(this.repository.tableName, nextReview, {
        expectedVersion: expected.expectedVersion,
        expectedRevision: expected.expectedRevision,
        expectedHash: expected.expectedHash
      }),
      analysisBindingCheck(this.repository.tableName, analysisEntity.pk, memoId, expected),
      decisionEntity
        ? casEntityPut(this.repository.tableName, decisionItem, decisionVersion)
        : immutablePut(this.repository.tableName, decisionItem),
      this.repository.outboxPut(userId, auditEvent)
    ]);
    return { ...transition, auditEvents: [structuredClone(auditEvent)] };
  }

  private async reviewEntity(userId: string, memoId: string) {
    return this.repository.getItem<ReviewEntity>(userId, workspaceSk.review(memoId));
  }

  private async requireReviewEntity(userId: string, memoId: string) {
    const item = await this.reviewEntity(userId, memoId);
    if (!item) throw new WorkspaceNotFoundError("Review not found.");
    return item;
  }

  private async hydrateReview(userId: string, item: ReviewEntity): Promise<MemoRecord> {
    const body = await this.content.get(item.contentRef, WORKSPACE_MEMO_MAX_BYTES, {
      tenantId: this.repository.tenantId,
      userId,
      entity: contentEntity(item.contentRef)
    });
    return { ...structuredClone(item.review), memoText: Buffer.from(body).toString("utf8") };
  }

  private async hydrateAnalysis(userId: string, item: AnalysisEntity): Promise<ReviewResult> {
    const body = await this.content.get(item.analysisRef, WORKSPACE_ANALYSIS_MAX_BYTES, {
      tenantId: this.repository.tenantId, userId, entity: "analysis"
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      throw new WorkspaceIntegrityError("Stored analysis is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || (parsed as ReviewResult).memoId !== item.memoId) {
      throw new WorkspaceIntegrityError("Stored analysis is bound to another review.");
    }
    const result = parsed as ReviewResult;
    if ((result.resultHash ?? hashReviewResult(result)) !== item.analysisHash) {
      throw new WorkspaceIntegrityError("Stored analysis hash does not match its pointer.");
    }
    return result;
  }

  private async hydrateChat(userId: string, item: ChatEntity): Promise<MemoChatMessage> {
    let proposedMemoText: string | undefined;
    if (item.proposedMemoRef) {
      const body = await this.content.get(item.proposedMemoRef, WORKSPACE_MEMO_MAX_BYTES, {
        tenantId: this.repository.tenantId, userId, entity: "chat-suggestion"
      });
      proposedMemoText = Buffer.from(body).toString("utf8");
    }
    return {
      ...structuredClone(item.message),
      sequence: item.messageSequence,
      ...(proposedMemoText === undefined ? {} : { proposedMemoText })
    };
  }

  private async putMemoRevision(userId: string, revision: MemoRevision) {
    return this.content.putImmutable({
      tenantId: this.repository.tenantId,
      userId,
      entity: "memo-revision",
      id: `${revision.memoId}/${revision.revision}`,
      body: revision.memoText,
      mimeType: "text/plain; charset=utf-8",
      maxBytes: WORKSPACE_MEMO_MAX_BYTES
    });
  }

  private async chatItem(userId: string, message: MemoChatMessage, messageSequence: number): Promise<ChatEntity> {
    assertUtf8Field(message.text, "chat message text", WORKSPACE_CHAT_TEXT_MAX_BYTES);
    const { proposedMemoText, sequence: _untrustedSequence, ...messageRecord } = message;
    const proposedMemoRef = proposedMemoText === undefined
      ? undefined
      : await this.content.putImmutable({
          tenantId: this.repository.tenantId,
          userId,
          entity: "chat-suggestion",
          id: `${message.memoId}/${message.id}`,
          body: proposedMemoText,
          mimeType: "text/plain; charset=utf-8",
          maxBytes: WORKSPACE_MEMO_MAX_BYTES
        });
    const pk = workspacePk(this.repository.tenantId, userId);
    const item: ChatEntity = {
      pk,
      sk: workspaceSk.chat(message.memoId, message.id),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: "CH",
      entityVersion: 1,
      message: structuredClone(messageRecord),
      messageSequence,
      gsi1pk: `${pk}#CHAT#${keyPrefix(message.memoId)}`,
      gsi1sk: `CH#${sequenceKey(messageSequence)}#${workspaceSk.chat(message.memoId, message.id)}`,
      ...(proposedMemoRef ? { proposedMemoRef } : {}),
      createdAt: message.createdAt,
      updatedAt: message.createdAt
    };
    assertWorkspaceItemSize(item, 48 * 1024);
    return item;
  }

  private async listOutreachValues<T>(userId: string, kind: string, maximum: number) {
    await this.repository.requireMigrated(userId);
    const items = await this.queryAll<OutreachEntity<T>>(
      userId, `OUT#${keyPrefix(kind)}#`, 100, maximum
    );
    const values = items.map((item) => structuredClone(item.value));
    assertWorkspaceResponseSize(values);
    return values;
  }

  private async listOutreachValuesPage<T>(userId: string, kind: string, query: PageQuery): Promise<CursorPage<T>> {
    await this.repository.requireMigrated(userId);
    const page = await this.repository.queryPage<OutreachEntity<T>>({
      userId,
      prefix: `OUT#${keyPrefix(kind)}#`,
      limit: query.limit,
      maxLimit: 50,
      cursor: query.cursor,
      forward: kind !== "RUN" && kind !== "JOB"
    });
    const result: CursorPage<T> = {
      items: page.items.map((item) => structuredClone(item.value)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    };
    assertWorkspaceResponseSize(result);
    return result;
  }

  private async getOutreachValue<T>(userId: string, kind: string, id: string) {
    await this.repository.requireMigrated(userId);
    const item = await this.repository.getItem<OutreachEntity<T>>(
      userId, workspaceSk.outreach(kind, id)
    );
    return item ? structuredClone(item.value) : undefined;
  }

  private async upsertOutreachValue<T>(
    userId: string,
    kind: string,
    id: string,
    value: T,
    updatedAt: string,
    expectedUpdatedAt?: string
  ) {
    await this.repository.requireMigrated(userId);
    const item = this.outreachItem(userId, kind, id, value, updatedAt);
    const transaction = expectedUpdatedAt === undefined
      ? immutablePut(this.repository.tableName, item)
      : conditionalOutreachPut(this.repository.tableName, item, expectedUpdatedAt);
    await this.repository.transact([transaction]);
  }

  private outreachPut<T>(userId: string, kind: string, id: string, value: T, updatedAt?: string) {
    const item = this.outreachItem(userId, kind, id, value, updatedAt);
    return {
      Put: { TableName: this.repository.tableName, Item: item }
    } satisfies TransactionItems[number];
  }

  private outreachItem<T>(userId: string, kind: string, id: string, value: T, updatedAt?: string) {
    const now = this.now().toISOString();
    const item: OutreachEntity<T> = {
      pk: workspacePk(this.repository.tenantId, userId),
      sk: workspaceSk.outreach(kind, id),
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entityType: `OUT_${kind}`,
      entityVersion: 1,
      value: structuredClone(value),
      valueUpdatedAt: updatedAt ?? now,
      createdAt: now,
      updatedAt: now
    };
    assertWorkspaceItemSize(item, 64 * 1024);
    return item;
  }

  private async queryAll<T extends WorkspaceItem>(
    userId: string,
    prefix: string,
    pageSize: number,
    maximum: number
  ) {
    const output: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.queryPage<T>({
        userId, prefix, limit: pageSize, maxLimit: pageSize, cursor
      });
      output.push(...page.items);
      if (output.length > maximum) {
        throw new WorkspaceValidationError(
          `The ${prefix} collection exceeds the bounded ${maximum}-entity response limit.`
        );
      }
      cursor = page.nextCursor;
    } while (cursor);
    return output;
  }

}

function reviewEntityItem(
  tenantId: string,
  userId: string,
  review: MemoRecord,
  contentRef: WorkspaceContentRef,
  createdAt: string
): ReviewEntity {
  const { memoText: _memoText, ...metadata } = review;
  const pk = workspacePk(tenantId, userId);
  const updatedAt = canonicalDate(review.updatedAt);
  const archived = Boolean(review.archivedAt || review.status === "archived");
  const item: ReviewEntity = {
    pk,
    sk: workspaceSk.review(review.id),
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    entityType: "R",
    entityVersion: review.version ?? review.revision ?? 1,
    review: structuredClone(metadata),
    contentRef,
    currentRevision: review.revision ?? 1,
    gsi1pk: `${pk}#REVIEWS`,
    gsi1sk: `R#${updatedAt}#${review.id}`,
    gsi2pk: `${pk}#REVIEWS#${archived ? "ARCHIVED" : "ACTIVE"}`,
    gsi2sk: `R#${updatedAt}#${review.id}`,
    createdAt,
    updatedAt
  };
  assertWorkspaceItemSize(item, 32 * 1024);
  return item;
}

function revisionEntityItem(
  tenantId: string,
  userId: string,
  revision: MemoRevision,
  contentRef: WorkspaceContentRef
): RevisionEntity {
  const { memoText: _memoText, ...metadata } = revision;
  const item: RevisionEntity = {
    pk: workspacePk(tenantId, userId),
    sk: workspaceSk.revision(revision.memoId, revision.revision),
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    entityType: "RV",
    entityVersion: revision.revision,
    revision: structuredClone(metadata),
    contentRef,
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt
  };
  assertWorkspaceItemSize(item, 8 * 1024);
  return item;
}

function chatMetaItem(
  tenantId: string,
  userId: string,
  memoId: string,
  nextSequence: number,
  current: ChatMetaEntity | undefined,
  messages: MemoChatMessage[],
  now: string
): ChatMetaEntity {
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1 || nextSequence > 999_999_999_999) {
    throw new WorkspaceValidationError("Chat sequence is outside its supported range.");
  }
  const previousWindow = current ? authoritativeChatHistoryWindow(current) : [];
  const firstSequence = nextSequence - messages.length;
  const historyWindow = [
    ...previousWindow,
    ...messages.map((message, index) => aiApprovalChatHistoryEntry({
      ...message,
      sequence: firstSequence + index
    }))
  ].slice(-200);
  const item: ChatMetaEntity = {
    pk: workspacePk(tenantId, userId),
    sk: workspaceSk.chatMeta(memoId),
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    entityType: "CHAT_META",
    entityVersion: (current?.entityVersion ?? 0) + 1,
    memoId,
    nextSequence,
    historySchemaVersion: AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION,
    historyWindow,
    historyHash: hashAiApprovalChatHistoryEntries(historyWindow),
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };
  assertWorkspaceItemSize(item, 96 * 1024);
  return item;
}

function chatMetaAfterSuggestion(
  current: ChatMetaEntity,
  message: MemoChatMessage,
  now: string
): ChatMetaEntity {
  const window = authoritativeChatHistoryWindow(current);
  const index = window.findIndex((entry) => entry.id === message.id);
  if (index < 0) {
    throw new WorkspaceIntegrityError("Chat suggestion is outside the authoritative history window.");
  }
  const historyWindow = [...window];
  historyWindow[index] = aiApprovalChatHistoryEntry(message);
  const item: ChatMetaEntity = {
    ...current,
    entityVersion: current.entityVersion! + 1,
    historyWindow,
    historyHash: hashAiApprovalChatHistoryEntries(historyWindow),
    updatedAt: now
  };
  delete item.aiDispatchClaim;
  assertWorkspaceItemSize(item, 96 * 1024);
  return item;
}

function authoritativeChatHistoryWindow(meta: ChatMetaEntity) {
  if (meta.historySchemaVersion !== AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION ||
      !Array.isArray(meta.historyWindow) || typeof meta.historyHash !== "string" ||
      meta.historyWindow.length !== Math.min(meta.nextSequence, 200)) {
    throw new WorkspaceIntegrityError(
      "Chat history metadata requires the authoritative memo-chat fence migration."
    );
  }
  const expected = hashAiApprovalChatHistoryEntries(meta.historyWindow);
  if (expected !== meta.historyHash) {
    throw new WorkspaceIntegrityError("Authoritative chat history metadata is corrupt.");
  }
  return structuredClone(meta.historyWindow);
}

function authoritativeChatFence(meta: ChatMetaEntity | undefined): AiApprovalMemoChatFence {
  if (!meta) {
    return {
      historyHash: hashAiApprovalChatHistoryEntries([]),
      chatMeta: { exists: false }
    };
  }
  authoritativeChatHistoryWindow(meta);
  if (!Number.isSafeInteger(meta.entityVersion) || meta.entityVersion! < 1 ||
      !Number.isSafeInteger(meta.nextSequence) || meta.nextSequence < 0) {
    throw new WorkspaceIntegrityError("Authoritative chat sequence metadata is corrupt.");
  }
  return {
    historyHash: meta.historyHash,
    chatMeta: {
      exists: true,
      entityVersion: meta.entityVersion!,
      nextSequence: meta.nextSequence
    }
  };
}

function chatFenceCondition(
  tableName: string,
  pk: string,
  sk: string,
  fence: AiApprovalMemoChatFence
): TransactionItems[number] {
  if (!fence.chatMeta.exists) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: { pk, sk },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" }
      }
    };
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk, sk },
      ConditionExpression: [
        "#entityVersion = :version",
        "#nextSequence = :nextSequence",
        "#historyHash = :historyHash",
        "#historySchemaVersion = :historySchemaVersion"
      ].join(" AND "),
      ExpressionAttributeNames: {
        "#entityVersion": "entityVersion",
        "#nextSequence": "nextSequence",
        "#historyHash": "historyHash",
        "#historySchemaVersion": "historySchemaVersion"
      },
      ExpressionAttributeValues: {
        ":version": fence.chatMeta.entityVersion,
        ":nextSequence": fence.chatMeta.nextSequence,
        ":historyHash": fence.historyHash,
        ":historySchemaVersion": AI_APPROVAL_CHAT_HISTORY_SCHEMA_VERSION
      }
    }
  };
}

/** Commits chat messages only while the exact provider-start claim observed by
 * the caller is still current. Claim transitions intentionally do not advance
 * the history entityVersion, so the claim predicate must live in this same
 * transaction rather than in a preceding read. */
function chatMetaAppendPut(
  tableName: string,
  item: ChatMetaEntity,
  current: ChatMetaEntity,
  expectedClaim: AiMemoChatDispatchClaim | undefined,
  nowEpoch: number
): TransactionItems[number] {
  assertWorkspaceItemSize(item, 96 * 1024);
  const conditions = ["#entityVersion = :expectedVersion"];
  const names: Record<string, string> = {
    "#entityVersion": "entityVersion",
    "#aiDispatchClaim": "aiDispatchClaim",
    "#expiresAtEpoch": "expiresAtEpoch"
  };
  const values: Record<string, unknown> = {
    ":expectedVersion": current.entityVersion ?? 1,
    ":nowEpoch": nowEpoch
  };
  if (!expectedClaim) {
    conditions.push("(attribute_not_exists(#aiDispatchClaim) OR #aiDispatchClaim.#expiresAtEpoch <= :nowEpoch)");
  } else if (expectedClaim.outcome === "failed") {
    conditions.push("attribute_not_exists(#aiDispatchClaim)");
  } else {
    conditions.push(
      "#aiDispatchClaim.#dispatchId = :dispatchId",
      "#aiDispatchClaim.#requestHash = :requestHash",
      "#aiDispatchClaim.#reservationToken = :reservationToken",
      "#aiDispatchClaim.#expiresAtEpoch > :nowEpoch"
    );
    Object.assign(names, {
      "#dispatchId": "dispatchId",
      "#requestHash": "requestHash",
      "#reservationToken": "reservationToken"
    });
    Object.assign(values, {
      ":dispatchId": expectedClaim.dispatchId,
      ":requestHash": expectedClaim.requestHash,
      ":reservationToken": expectedClaim.reservationToken
    });
  }
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    }
  };
}

function assertNoLiveChatClaim(claim: AiMemoChatDispatchClaim | undefined, nowEpoch: number) {
  if (claim && claim.expiresAtEpoch > nowEpoch) {
    throw new WorkspaceConflictError("Another memo-chat turn is already in progress.");
  }
}

function assertChatAppendClaim(
  current: AiMemoChatDispatchClaim | undefined,
  expected: AiMemoChatDispatchClaim | undefined,
  currentFence: AiApprovalMemoChatFence,
  nowEpoch: number
) {
  if (!expected) {
    assertNoLiveChatClaim(current, nowEpoch);
    return;
  }
  if (expected.outcome === "failed") {
    if (current && current.expiresAtEpoch > nowEpoch) {
      throw new WorkspaceConflictError("Another memo-chat turn claimed this history before fallback append.");
    }
    if (!expected.fence || !sameChatFence(expected.fence, currentFence)) {
      throw new WorkspaceConflictError("Memo-chat history changed before fallback append.");
    }
    return;
  }
  if (!current || current.expiresAtEpoch <= nowEpoch ||
      current.dispatchId !== expected.dispatchId || current.requestHash !== expected.requestHash ||
      current.reservationToken !== expected.reservationToken) {
    throw new WorkspaceConflictError("Memo-chat append no longer owns the provider-start claim.");
  }
}

function sameChatFence(left: AiApprovalMemoChatFence, right: AiApprovalMemoChatFence) {
  return left.historyHash === right.historyHash &&
    left.chatMeta.exists === right.chatMeta.exists &&
    (!left.chatMeta.exists || !right.chatMeta.exists || (
      left.chatMeta.entityVersion === right.chatMeta.entityVersion &&
      left.chatMeta.nextSequence === right.chatMeta.nextSequence
    ));
}

function transitionState(
  review: MemoRecord,
  overrides: Partial<AccountReviewState> = {}
): AccountReviewState {
  return {
    ...emptyTransitionState(),
    memos: [structuredClone(review)],
    ...overrides
  };
}

function emptyTransitionState(): AccountReviewState {
  return {
    schemaVersion: 2,
    version: 0,
    memos: [],
    decisions: {},
    auditEvents: [],
    analysisResults: {},
    chatMessages: {},
    memoRevisions: {},
    comments: {},
    notifications: [],
    memoBuilder: { messages: [], sessions: [] },
    outreachDrafts: {},
    discoveredLeads: [],
    leadSearchRuns: [],
    leadWorkflows: {},
    outreachJobs: []
  };
}

function analysisSummary(result: ReviewResult) {
  return {
    id: result.id,
    memoId: result.memoId,
    memoRevision: result.memoRevision,
    inputHash: result.inputHash,
    resultHash: result.resultHash,
    generatedAt: result.generatedAt,
    provider: result.provider,
    recommended: result.recommended,
    jurisdiction: result.jurisdiction,
    corpusId: result.corpusId,
    corpusChecksum: result.corpusChecksum
  };
}

function responsePage<T>(items: T[], nextCursor?: string): CursorPage<T> {
  const page = { items: structuredClone(items), ...(nextCursor ? { nextCursor } : {}) };
  assertWorkspaceResponseSize(page);
  return page;
}

function reviewSummary(review: Omit<MemoRecord, "memoText">): ReviewSummary {
  const { attachments: _attachments, ...summary } = review;
  return structuredClone(summary);
}

function contentEntity(ref: WorkspaceContentRef) {
  const segments = ref.key.split("/");
  if (segments.length < 6) throw new WorkspaceIntegrityError("Memo content key is malformed.");
  return decodeURIComponent(segments[4]!);
}

function keyPrefix(value: string) {
  const key = workspaceSk.review(value);
  return key.slice(2);
}

function sequenceKey(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) {
    throw new WorkspaceValidationError("Chat sequence is outside its supported range.");
  }
  return value.toString().padStart(12, "0");
}

function canonicalDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new WorkspaceValidationError("Entity updatedAt is invalid.");
  return new Date(timestamp).toISOString();
}

function validateBuilderSession(session: MemoBuilderSession) {
  const serializedBytes = Buffer.byteLength(stableCanonicalJson(session), "utf8");
  if (serializedBytes > WORKSPACE_BUILDER_SESSION_MAX_BYTES) {
    throw new WorkspaceValidationError(
      `Memo Builder session is ${serializedBytes} bytes; the maximum is ${WORKSPACE_BUILDER_SESSION_MAX_BYTES} bytes.`
    );
  }
  if (session.messages.length > 20) {
    throw new WorkspaceValidationError("Memo Builder sessions may contain at most 20 messages.");
  }
  if (![
    "public", "proprietary", "export-controlled", "itar-risk", "cui"
  ].includes(session.dataClass)) {
    throw new WorkspaceValidationError("Memo Builder session classification is invalid.");
  }
  for (const message of session.messages) {
    assertUtf8Field(message.content, "builder message", WORKSPACE_CHAT_TEXT_MAX_BYTES);
  }
  canonicalDate(session.updatedAt);
}

function immutablePut(tableName: string, item: WorkspaceItem): TransactionItems[number] {
  assertWorkspaceItemSize(item);
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" }
    }
  };
}

function casEntityPut(
  tableName: string,
  item: WorkspaceItem,
  expectedVersion: number,
  requireComplete = false
): TransactionItems[number] {
  assertWorkspaceItemSize(item);
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: requireComplete
        ? "#entityVersion = :expectedVersion AND #migrationStatus = :complete"
        : "#entityVersion = :expectedVersion",
      ExpressionAttributeNames: {
        "#entityVersion": "entityVersion",
        ...(requireComplete ? { "#migrationStatus": "migrationStatus" } : {})
      },
      ExpressionAttributeValues: {
        ":expectedVersion": expectedVersion,
        ...(requireComplete ? { ":complete": "complete" } : {})
      }
    }
  };
}

function casReviewPut(
  tableName: string,
  item: ReviewEntity,
  expected: { expectedVersion: number; expectedRevision: number; expectedHash: string }
): TransactionItems[number] {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        "#entityVersion = :expectedVersion AND #review.#revision = :expectedRevision AND #review.#contentHash = :expectedHash",
      ExpressionAttributeNames: {
        "#entityVersion": "entityVersion",
        "#review": "review",
        "#revision": "revision",
        "#contentHash": "contentHash"
      },
      ExpressionAttributeValues: {
        ":expectedVersion": expected.expectedVersion,
        ":expectedRevision": expected.expectedRevision,
        ":expectedHash": expected.expectedHash
      }
    }
  };
}

function reviewBindingCheck(
  tableName: string,
  pk: string,
  memoId: string,
  expected: { expectedVersion: number; expectedRevision: number; expectedHash: string }
): TransactionItems[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk, sk: workspaceSk.review(memoId) },
      ConditionExpression:
        "#entityVersion = :expectedVersion AND #review.#revision = :expectedRevision AND #review.#contentHash = :expectedHash",
      ExpressionAttributeNames: {
        "#entityVersion": "entityVersion", "#review": "review",
        "#revision": "revision", "#contentHash": "contentHash"
      },
      ExpressionAttributeValues: {
        ":expectedVersion": expected.expectedVersion,
        ":expectedRevision": expected.expectedRevision,
        ":expectedHash": expected.expectedHash
      }
    }
  };
}

function analysisBindingCheck(
  tableName: string,
  pk: string,
  memoId: string,
  expected: DecisionExpectedBindings
): TransactionItems[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk, sk: workspaceSk.analysisCurrent(memoId) },
      ConditionExpression: "#analysisId = :analysisId AND #analysisHash = :analysisHash",
      ExpressionAttributeNames: { "#analysisId": "analysisId", "#analysisHash": "analysisHash" },
      ExpressionAttributeValues: {
        ":analysisId": expected.expectedAnalysisId,
        ":analysisHash": expected.expectedAnalysisHash
      }
    }
  };
}

function metaReadyCheck(tableName: string, pk: string): TransactionItems[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk, sk: workspaceSk.meta() },
      ConditionExpression: "#migrationStatus = :complete",
      ExpressionAttributeNames: { "#migrationStatus": "migrationStatus" },
      ExpressionAttributeValues: { ":complete": "complete" }
    }
  };
}

function deleteItem(tableName: string, pk: string, sk: string): TransactionItems[number] {
  return { Delete: { TableName: tableName, Key: { pk, sk } } };
}

function conditionalDelete(
  tableName: string,
  pk: string,
  sk: string,
  expectedVersion: number
): TransactionItems[number] {
  return {
    Delete: {
      TableName: tableName,
      Key: { pk, sk },
      ConditionExpression: "#entityVersion = :expectedVersion",
      ExpressionAttributeNames: { "#entityVersion": "entityVersion" },
      ExpressionAttributeValues: { ":expectedVersion": expectedVersion }
    }
  };
}

function builderCountUpdate(
  tableName: string,
  pk: string,
  delta: 1 | -1,
  updatedAt: string
): TransactionItems[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { pk, sk: workspaceSk.meta() },
      UpdateExpression: "ADD #builderSessionCount :delta, #entityVersion :one SET #updatedAt = :updatedAt",
      ConditionExpression: delta > 0
        ? "#migrationStatus = :complete AND (attribute_not_exists(#builderSessionCount) OR #builderSessionCount < :maximum)"
        : "#migrationStatus = :complete AND #builderSessionCount > :zero",
      ExpressionAttributeNames: {
        "#builderSessionCount": "builderSessionCount",
        "#entityVersion": "entityVersion",
        "#updatedAt": "updatedAt",
        "#migrationStatus": "migrationStatus"
      },
      ExpressionAttributeValues: {
        ":delta": delta,
        ":one": 1,
        ":updatedAt": updatedAt,
        ":complete": "complete",
        ...(delta > 0 ? { ":maximum": 50 } : { ":zero": 0 })
      }
    }
  };
}

function conditionalOutreachPut(
  tableName: string,
  item: WorkspaceItem,
  expectedUpdatedAt: string
): TransactionItems[number] {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: "#valueUpdatedAt = :expectedUpdatedAt",
      ExpressionAttributeNames: { "#valueUpdatedAt": "valueUpdatedAt" },
      ExpressionAttributeValues: { ":expectedUpdatedAt": expectedUpdatedAt }
    }
  };
}

function chunk<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

export function isWorkspaceAdapterError(error: unknown): error is
  | WorkspaceValidationError
  | WorkspaceConflictError
  | WorkspaceContentGcActiveError
  | WorkspaceNotMigratedError
  | WorkspaceNotFoundError
  | WorkspaceIntegrityError {
  return error instanceof WorkspaceValidationError || error instanceof WorkspaceConflictError ||
    error instanceof WorkspaceContentGcActiveError ||
    error instanceof WorkspaceNotFoundError ||
    error instanceof WorkspaceNotMigratedError || error instanceof WorkspaceIntegrityError;
}
