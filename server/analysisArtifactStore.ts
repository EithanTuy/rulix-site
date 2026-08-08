import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { hashAiApprovalPayload } from "./domain/aiApproval";

export interface AnalysisArtifactStore {
  put<T>(accountId: string, runId: string, stage: string, value: T): Promise<{ ref: string; hash: string }>;
  get<T>(accountId: string, ref: string): Promise<T | undefined>;
}

export class InMemoryAnalysisArtifactStore implements AnalysisArtifactStore {
  private readonly values = new Map<string, unknown>();

  async put<T>(accountId: string, runId: string, stage: string, value: T) {
    const hash = hashAiApprovalPayload(value);
    const ref = `${safeSegment(accountId)}/${safeSegment(runId)}/${safeSegment(stage)}-${hash}.json`;
    const current = this.values.get(ref);
    if (current !== undefined && hashAiApprovalPayload(current) !== hash) {
      throw new Error("Analysis artifact immutability violation.");
    }
    this.values.set(ref, structuredClone(value));
    return { ref, hash };
  }

  async get<T>(accountId: string, ref: string) {
    if (!ref.startsWith(`${safeSegment(accountId)}/`)) throw new Error("Analysis artifact account binding mismatch.");
    const value = this.values.get(ref);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
}

export class S3AnalysisArtifactStore implements AnalysisArtifactStore {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
    private readonly kmsKeyId = process.env.RULIX_EVIDENCE_KMS_KEY_ID?.trim()
  ) {}

  async put<T>(accountId: string, runId: string, stage: string, value: T) {
    const hash = hashAiApprovalPayload(value);
    const ref = `${safeSegment(accountId)}/${safeSegment(runId)}/${safeSegment(stage)}-${hash}.json`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `analysis-artifacts/${ref}`,
      Body: `${JSON.stringify(value)}\n`,
      ContentType: "application/json",
      Metadata: { "rulix-artifact-sha256": hash },
      IfNoneMatch: "*",
      ...(this.kmsKeyId ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.kmsKeyId } : {})
    })).catch((error) => {
      if (!isPreconditionFailure(error)) throw error;
    });
    return { ref, hash };
  }

  async get<T>(accountId: string, ref: string) {
    if (!ref.startsWith(`${safeSegment(accountId)}/`)) throw new Error("Analysis artifact account binding mismatch.");
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: `analysis-artifacts/${ref}`
      }));
      const body = await response.Body?.transformToString("utf8");
      return body ? JSON.parse(body) as T : undefined;
    } catch (error) {
      const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }
}

function safeSegment(value: string) {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  if (!segment) throw new Error("Analysis artifact key segment is empty.");
  return segment;
}

function isPreconditionFailure(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412;
}
