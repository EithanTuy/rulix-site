import {
  AiEgressPolicyError,
  type AiDispatchAuthorizationHook,
  type AiDispatchAuthorizationSettlement
} from "./aiEgressGateway";
import {
  StoreError,
  type AccountStore,
  type TransitionAiDispatchRequest
} from "./store";

export interface StoreAiDispatchAuthorizationOptions {
  store: Pick<AccountStore, "reserveAiDispatch" | "transitionAiDispatch">;
  now?: () => number;
}

/**
 * Installs durable, sink-adjacent approval authorization. The hook receives
 * hashes and IDs only—never prompts, memo text, or document bytes.
 */
export function createStoreAiDispatchAuthorizationHook(
  options: StoreAiDispatchAuthorizationOptions
): AiDispatchAuthorizationHook {
  const now = options.now ?? Date.now;
  return async (metadata) => {
    let reservation;
    try {
      reservation = await options.store.reserveAiDispatch({
        accountId: metadata.accountId,
        ...(metadata.authorization.kind === "approval"
          ? {
              approvalId: metadata.authorization.approvalId,
              subject: metadata.authorization.subject
            }
          : {
              trustedWorkflow: metadata.authorization.workflow,
              trustedSubjectId: metadata.authorization.subjectId
            }),
        dataClass: metadata.dataClass,
        dispatchId: metadata.dispatchId,
        payloadHash: metadata.payloadHash,
        providerRequestHash: metadata.providerRequestHash,
        purpose: metadata.purpose,
        policy: metadata.policy,
        nowMs: now()
      });
    } catch (error) {
      throw authorizationError(error);
    }

    let settled = false;
    let started = false;
    const transition = async (kind: TransitionAiDispatchRequest["transition"]) => {
      try {
        await options.store.transitionAiDispatch({
          accountId: metadata.accountId,
          dispatchId: metadata.dispatchId,
          requestHash: reservation.requestHash,
          reservationToken: reservation.reservationToken,
          transition: kind,
          nowMs: now()
        });
      } catch (error) {
        throw authorizationError(error);
      }
    };
    return {
      replayed: reservation.replayed,
      markProviderStarted: async () => {
        if (reservation.replayed || started) return;
        await transition("mark-started");
        started = true;
      },
      settle: async (result: AiDispatchAuthorizationSettlement) => {
        if (reservation.replayed || settled) return;
        settled = true;
        await transition(settlementTransition(result));
      }
    };
  };
}

function settlementTransition(
  result: AiDispatchAuthorizationSettlement
): TransitionAiDispatchRequest["transition"] {
  if (result.status === "released") return "release";
  return result.status === "succeeded" ? "settle-succeeded" : "settle-failed";
}

function authorizationError(error: unknown) {
  if (error instanceof AiEgressPolicyError) return error;
  if (error instanceof StoreError) {
    return new AiEgressPolicyError(
      error.code ?? "ai_authorization_denied",
      error.message,
      error.status
    );
  }
  return new AiEgressPolicyError(
    "ai_authorization_unavailable",
    "AI dispatch authorization is temporarily unavailable.",
    503
  );
}
