import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
  type ObjectVersion
} from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { workspaceKeySegment, type WorkspaceContentRef } from "../server/workspaceV2";
import {
  DynamoWorkspaceContentGcLeaseStore,
  WorkspaceContentGcLeaseSession,
  defaultWorkspaceContentGcLeaseConfig
} from "../server/workspaceContentGc";

interface Options {
  apply: boolean;
  tenantId: string;
  graceHours: number;
  writerDrainSeconds: number;
  leaseSeconds: number;
  deleteTimeoutSeconds: number;
  confirmBucket?: string;
}

interface Candidate {
  key: string;
  versionId: string;
  size: number;
}

let abortRequested = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { abortRequested = true; });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const region = requiredEnv("AWS_REGION");
  const tableName = requiredEnv("RULIX_WORKSPACE_TABLE");
  const bucket = requiredEnv("RULIX_WORKSPACE_CONTENT_BUCKET");
  const roleArn = requiredEnv("RULIX_WORKSPACE_CONTENT_GC_ROLE_ARN");
  if (options.apply && options.confirmBucket !== bucket) {
    throw new Error(`Apply requires --confirm-bucket ${bucket}.`);
  }
  const credentials = await assumeRole(roleArn, region, options.tenantId);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }), {
    marshallOptions: { removeUndefinedValues: true }
  });
  const s3 = new S3Client({ region, credentials });

  if (!options.apply) {
    const references = await collectCommittedReferences(doc, tableName, bucket, options.tenantId);
    const cutoff = Date.now() - options.graceHours * 60 * 60 * 1000;
    const candidates = await collectOrphans(s3, bucket, options.tenantId, references, cutoff);
    writeSummary(options, references, candidates);
    return;
  }

  const config = defaultWorkspaceContentGcLeaseConfig({
    leaseMs: options.leaseSeconds * 1000,
    writerDrainMs: options.writerDrainSeconds * 1000,
    deleteTimeoutMs: options.deleteTimeoutSeconds * 1000
  });
  const lease = new WorkspaceContentGcLeaseSession(
    new DynamoWorkspaceContentGcLeaseStore(tableName, options.tenantId, doc),
    config
  );
  const owner = `gc-${randomUUID()}`;
  let acquired = false;
  try {
    const handle = await lease.acquire(owner);
    acquired = true;
    process.stdout.write(`${JSON.stringify({
      event: "lease-acquired",
      owner,
      fence: handle.fence,
      writerDrainSeconds: options.writerDrainSeconds
    })}\n`);

    // This drain is at least the app Lambda's maximum 120-second execution
    // window by default. Any writer reaching DynamoDB after acquisition is
    // rejected atomically by the lease condition and must restart its entire
    // content operation after cooldown.
    await lease.drainWriters(async () => { throwIfAborted(); });
    throwIfAborted();

    const heartbeat = async () => {
      throwIfAborted();
      await lease.heartbeat();
    };
    const references = await collectCommittedReferences(
      doc, tableName, bucket, options.tenantId, heartbeat
    );
    const cutoff = Date.now() - options.graceHours * 60 * 60 * 1000;
    const candidates = await collectOrphans(
      s3, bucket, options.tenantId, references, cutoff, heartbeat
    );
    writeSummary(options, references, candidates, handle.fence);

    let deletedVersions = 0;
    for (const batch of chunk(candidates, 1000)) {
      throwIfAborted();
      await lease.deleteBatch(async (abortSignal) => {
        const response = await s3.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Quiet: true,
            Objects: batch.map((candidate) => ({ Key: candidate.key, VersionId: candidate.versionId }))
          }
        }), { abortSignal });
        if (response.Errors?.length) {
          throw new Error(`S3 rejected ${response.Errors.length} exact-version orphan deletions.`);
        }
      });
      deletedVersions += batch.length;
      process.stdout.write(`${JSON.stringify({ event: "delete-progress", deletedVersions })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ deletedVersions })}\n`);
  } finally {
    if (acquired) {
      // Release is fenced by owner+epoch and deliberately leaves a cooldown
      // record so an already-dispatched S3 request cannot race a new writer.
      await lease.release();
      process.stdout.write(`${JSON.stringify({ event: "lease-released", owner })}\n`);
    }
  }
}

async function collectCommittedReferences(
  doc: DynamoDBDocumentClient,
  tableName: string,
  bucket: string,
  tenantId: string,
  heartbeat?: () => Promise<void>
) {
  const references = new Set<string>();
  const accountPrefix = `TENANT#${workspaceKeySegment(tenantId, "tenantId")}#USER#`;
  const contentPrefix = `tenant/${workspaceKeySegment(tenantId, "tenantId")}/`;
  let cursor: Record<string, unknown> | undefined;
  do {
    await heartbeat?.();
    const response = await doc.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: cursor,
      ConsistentRead: true,
      FilterExpression: "begins_with(#pk, :accountPrefix)",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":accountPrefix": accountPrefix }
    }));
    for (const item of response.Items ?? []) collectRefs(item, references, bucket, contentPrefix);
    cursor = response.LastEvaluatedKey;
    await heartbeat?.();
  } while (cursor);
  return references;
}

function collectRefs(
  value: unknown,
  references: Set<string>,
  bucket: string,
  contentPrefix: string
) {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, references, bucket, contentPrefix);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.bucket === bucket && typeof record.key === "string" && record.key.startsWith(contentPrefix) &&
    typeof record.versionId === "string" && typeof record.sha256 === "string"
  ) {
    const ref = record as unknown as WorkspaceContentRef;
    references.add(referenceKey(ref.key, ref.versionId));
  }
  for (const entry of Object.values(record)) collectRefs(entry, references, bucket, contentPrefix);
}

async function collectOrphans(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  references: Set<string>,
  cutoff: number,
  heartbeat?: () => Promise<void>
) {
  const prefix = `tenant/${workspaceKeySegment(tenantId, "tenantId")}/`;
  const candidates: Candidate[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    await heartbeat?.();
    const response = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
      MaxKeys: 1000
    }));
    for (const version of response.Versions ?? []) {
      const candidate = orphanCandidate(version, references, cutoff);
      if (candidate) candidates.push(candidate);
    }
    keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
    versionIdMarker = response.IsTruncated ? response.NextVersionIdMarker : undefined;
    if (response.IsTruncated && !keyMarker) {
      throw new Error("S3 version listing truncated without a continuation key.");
    }
    await heartbeat?.();
  } while (keyMarker);
  return candidates;
}

function orphanCandidate(version: ObjectVersion, references: Set<string>, cutoff: number): Candidate | undefined {
  if (!version.Key || !version.VersionId || !version.LastModified) return undefined;
  if (version.LastModified.getTime() > cutoff) return undefined;
  if (references.has(referenceKey(version.Key, version.VersionId))) return undefined;
  return { key: version.Key, versionId: version.VersionId, size: version.Size ?? 0 };
}

function referenceKey(key: string, versionId: string) {
  return `${key}\u0000${versionId}`;
}

function parseArgs(args: string[]): Options {
  let apply = false;
  let tenantId = process.env.RULIX_TENANT_ID?.trim() ?? "";
  let graceHours = 24;
  let writerDrainSeconds = 120;
  let leaseSeconds = 180;
  let deleteTimeoutSeconds = 15;
  let confirmBucket: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--tenant") tenantId = value;
    else if (argument === "--grace-hours") graceHours = Number(value);
    else if (argument === "--writer-drain-seconds") writerDrainSeconds = Number(value);
    else if (argument === "--lease-seconds") leaseSeconds = Number(value);
    else if (argument === "--delete-timeout-seconds") deleteTimeoutSeconds = Number(value);
    else if (argument === "--confirm-bucket") confirmBucket = value;
    else throw new Error(`Unknown argument ${argument}.`);
    index += 1;
  }
  workspaceKeySegment(tenantId, "tenantId");
  boundedInteger(graceHours, 1, 24 * 30, "--grace-hours");
  boundedInteger(writerDrainSeconds, 120, 3600, "--writer-drain-seconds");
  boundedInteger(leaseSeconds, 120, 3600, "--lease-seconds");
  boundedInteger(deleteTimeoutSeconds, 5, 30, "--delete-timeout-seconds");
  if (leaseSeconds <= deleteTimeoutSeconds) {
    throw new Error("--lease-seconds must exceed --delete-timeout-seconds.");
  }
  return {
    apply,
    tenantId,
    graceHours,
    writerDrainSeconds,
    leaseSeconds,
    deleteTimeoutSeconds,
    confirmBucket
  };
}

async function assumeRole(roleArn: string, region: string, tenantId: string) {
  const response = await new STSClient({ region }).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `rulix-workspace-gc-${tenantId.replace(/[^A-Za-z0-9+=,.@_-]/gu, "-").slice(0, 24)}`,
    DurationSeconds: 3600
  }));
  const credentials = response.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("Workspace content GC role returned incomplete credentials.");
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration
  };
}

function writeSummary(
  options: Options,
  references: Set<string>,
  candidates: Candidate[],
  fence?: number
) {
  process.stdout.write(`${JSON.stringify({
    mode: options.apply ? "apply" : "plan",
    tenantId: options.tenantId,
    graceHours: options.graceHours,
    ...(fence === undefined ? {} : { fence }),
    committedReferences: references.size,
    orphanVersions: candidates.length,
    orphanBytes: candidates.reduce((sum, candidate) => sum + candidate.size, 0)
  })}\n`);
}

function throwIfAborted() {
  if (abortRequested) throw new Error("Workspace content GC aborted by operator signal.");
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function chunk<T>(values: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "Unknown GC failure." })}\n`);
  process.exitCode = 1;
});
