import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { createAiDispatchAdmissionHook } from "./aiAdmission";
import { createStoreAiDispatchAuthorizationHook } from "./aiAuthorization";
import { setAiDispatchAdmissionHook, setAiDispatchAuthorizationHook } from "./aiEgressGateway";
import { S3AnalysisArtifactStore } from "./analysisArtifactStore";
import { processAnalysisRun, type AnalysisRunQueueEvent } from "./analysisRuns";
import { createAccountStore } from "./store";

const store = createAccountStore();
const evidenceBucket = requiredEnvironment("RULIX_EVIDENCE_BUCKET");
const artifactStore = new S3AnalysisArtifactStore(evidenceBucket);
setAiDispatchAdmissionHook(createAiDispatchAdmissionHook({ store }));
setAiDispatchAuthorizationHook(createStoreAiDispatchAuthorizationHook({ store }));

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const message = parseEvent(record.body);
      await processAnalysisRun(message, {
        store,
        artifactStore,
        organizationPolicy: async () => undefined
      });
    } catch (error) {
      console.error("Analysis worker record failed", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : "Unknown worker error"
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function parseEvent(body: string): AnalysisRunQueueEvent {
  const value = JSON.parse(body) as Partial<AnalysisRunQueueEvent>;
  if (
    value.source !== "rulix.analysis-worker" ||
    value.schemaVersion !== 1 ||
    typeof value.accountId !== "string" ||
    typeof value.runId !== "string" ||
    !value.accountId ||
    !value.runId
  ) throw new Error("Analysis queue message is invalid.");
  return value as AnalysisRunQueueEvent;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the analysis worker.`);
  return value;
}
