import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  S3WorkspaceContentStore,
  WorkspaceConflictError,
  WorkspaceContentGcActiveError,
  WorkspaceIntegrityError,
  WorkspaceValidationError
} from "../server/workspaceV2";
import {
  DynamoLegacyAccountSource,
  DynamoWorkspaceMigrationBackend,
  createMigrationReceipt,
  migrateWorkspaceAccount,
  planWorkspaceMigration,
  type WorkspaceMigrationCheckpoint,
  type WorkspaceMigrationMode
} from "../server/workspaceV2Migration";

interface CliOptions {
  tenantId: string;
  mode: WorkspaceMigrationMode;
  all: boolean;
  account?: string;
  checkpointPath: string;
  concurrency: number;
  confirmDestination?: string;
  changeTicket?: string;
}

class MigrationCliError extends Error {
  constructor(message: string, readonly exitCode: 2 | 3 | 4) {
    super(message);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const region = requiredEnv("AWS_REGION");
  const sourceTable = requiredEnv("RULIX_ACCOUNT_TABLE");
  const destinationTable = requiredEnv("RULIX_WORKSPACE_TABLE");
  const contentBucket = requiredEnv("RULIX_WORKSPACE_CONTENT_BUCKET");
  const kmsKeyId = requiredEnv("RULIX_WORKSPACE_KMS_KEY_ARN");
  const roleArn = requiredEnv("RULIX_WORKSPACE_MIGRATION_ROLE_ARN");
  const receiptSecretArn = process.env.RULIX_MIGRATION_RECEIPT_SECRET_ARN?.trim();

  if (options.mode === "apply" && options.confirmDestination !== destinationTable) {
    throw new MigrationCliError(
      `Apply requires --confirm-destination ${destinationTable}.`,
      2
    );
  }
  if (isProduction() && options.mode === "apply" && !options.changeTicket?.trim()) {
    throw new MigrationCliError("Production apply requires --change-ticket.", 2);
  }
  if (options.mode !== "plan" && !receiptSecretArn) {
    throw new MigrationCliError(
      "Apply and verify require RULIX_MIGRATION_RECEIPT_SECRET_ARN.",
      2
    );
  }

  const credentials = await assumeMigrationRole(roleArn, region, options.tenantId);
  const dynamo = new DynamoDBClient({ region, credentials });
  const doc = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true }
  });
  const s3 = new S3Client({ region, credentials });
  const receiptSigningKey = options.mode === "plan"
    ? undefined
    : await readReceiptSigningKey(receiptSecretArn!, region, credentials);
  const source = new DynamoLegacyAccountSource(sourceTable, options.tenantId, doc);
  const backend = new DynamoWorkspaceMigrationBackend(destinationTable, options.tenantId, doc);
  const content = new S3WorkspaceContentStore(contentBucket, kmsKeyId, { client: s3 });
  const checkpoint = loadCheckpoint(options, destinationTable);
  const receiptAccounts: Array<{
    userId: string;
    sourceDigest: string;
    migrationDigest: string;
    entityCount: number;
    status: "planned" | "migrated" | "verified" | "skipped";
  }> = [];
  let accountCount = 0;

  await runStreamingPool(streamAccounts(source, options), options.concurrency, async (account) => {
    accountCount += 1;
    const plan = await planWorkspaceMigration(options.tenantId, account.userId, account.state);
    const result = await migrateWorkspaceAccount({
      mode: options.mode,
      plan,
      backend,
      content,
      owner: `workspace-migration-${process.pid}-${randomUUID()}`
    });
    receiptAccounts.push({
      userId: account.userId,
      sourceDigest: plan.sourceDigest,
      migrationDigest: plan.migrationDigest,
      entityCount: plan.entityCount,
      status: result.status
    });
    if (options.mode !== "plan") {
      checkpoint.accounts[account.userId] = {
        sourceDigest: plan.sourceDigest,
        migrationDigest: plan.migrationDigest,
        status: options.mode === "verify" ? "verified" : "migrated",
        completedAt: new Date().toISOString()
      };
      checkpoint.updatedAt = new Date().toISOString();
      writeJsonAtomic(options.checkpointPath, checkpoint);
    }
    process.stdout.write(`${JSON.stringify({
      userId: account.userId,
      mode: options.mode,
      status: result.status,
      sourceDigest: plan.sourceDigest,
      migrationDigest: plan.migrationDigest,
      entityCount: plan.entityCount,
      contentObjectCount: plan.contentObjectCount,
      contentBytes: plan.contentBytes
    })}\n`);
  });

  if (accountCount === 0) {
    throw new MigrationCliError("No legacy accounts matched the requested scope.", 2);
  }

  if (options.mode !== "plan") {
    const receipt = createMigrationReceipt({
      mode: options.mode,
      tenantId: options.tenantId,
      destinationTable,
      changeTicket: options.changeTicket,
      accounts: receiptAccounts,
      signingKey: receiptSigningKey
    });
    const receiptPath = `${options.checkpointPath}.receipt.json`;
    writeJsonAtomic(receiptPath, receipt);
    process.stdout.write(`${JSON.stringify({ receiptPath, payloadHash: receipt.payloadHash })}\n`);
  }
}

async function readReceiptSigningKey(
  secretArn: string,
  region: string,
  credentials: Awaited<ReturnType<typeof assumeMigrationRole>>
) {
  const response = await new SecretsManagerClient({ region, credentials }).send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  const value = response.SecretString;
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    throw new MigrationCliError("Migration receipt secret is missing or shorter than 32 bytes.", 4);
  }
  return value;
}

function parseArgs(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueNames = new Set([
    "--tenant", "--mode", "--account", "--checkpoint", "--concurrency",
    "--confirm-destination", "--change-ticket"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--all") {
      flags.add(arg);
      continue;
    }
    if (!valueNames.has(arg)) throw new MigrationCliError(`Unknown argument ${arg}.`, 2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new MigrationCliError(`${arg} requires a value.`, 2);
    values.set(arg, value);
    index += 1;
  }

  const tenantId = values.get("--tenant") ?? env.RULIX_TENANT_ID?.trim();
  if (!tenantId) throw new MigrationCliError("--tenant or RULIX_TENANT_ID is required.", 2);
  const mode = values.get("--mode") ?? "plan";
  if (!(["plan", "apply", "verify"] as string[]).includes(mode)) {
    throw new MigrationCliError("--mode must be plan, apply, or verify.", 2);
  }
  const all = flags.has("--all");
  const account = values.get("--account");
  if (all === Boolean(account)) {
    throw new MigrationCliError("Choose exactly one of --all or --account <userId>.", 2);
  }
  const concurrency = Number(values.get("--concurrency") ?? "1");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new MigrationCliError("--concurrency must be an integer from 1 through 8.", 2);
  }
  return {
    tenantId,
    mode: mode as WorkspaceMigrationMode,
    all,
    account,
    checkpointPath: path.resolve(values.get("--checkpoint") ?? ".rulix-workspace-v2-checkpoint.json"),
    concurrency,
    confirmDestination: values.get("--confirm-destination"),
    changeTicket: values.get("--change-ticket")
  };
}

async function assumeMigrationRole(roleArn: string, region: string, tenantId: string) {
  const response = await new STSClient({ region }).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `rulix-workspace-${tenantId.replace(/[^A-Za-z0-9+=,.@_-]/gu, "-").slice(0, 32)}`,
    DurationSeconds: 3600
  }));
  const credentials = response.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new MigrationCliError("Migration role assumption returned incomplete credentials.", 4);
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration
  };
}

async function* streamAccounts(source: DynamoLegacyAccountSource, options: CliOptions) {
  if (options.account) {
    const account = await source.get(options.account);
    if (account) yield account;
    return;
  }
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await source.list(cursor, 50);
    for (const account of page.accounts.sort((left, right) => left.userId.localeCompare(right.userId))) {
      yield account;
    }
    cursor = page.nextCursor;
  } while (cursor);
}

function loadCheckpoint(options: CliOptions, destinationTable: string): WorkspaceMigrationCheckpoint {
  if (!existsSync(options.checkpointPath)) {
    return {
      schemaVersion: "rulix.workspace-migration-checkpoint/v1",
      tenantId: options.tenantId,
      destinationTable,
      updatedAt: new Date(0).toISOString(),
      accounts: {}
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(options.checkpointPath, "utf8"));
  } catch {
    throw new MigrationCliError("Migration checkpoint is not valid JSON.", 2);
  }
  const checkpoint = parsed as WorkspaceMigrationCheckpoint;
  if (
    checkpoint.schemaVersion !== "rulix.workspace-migration-checkpoint/v1" ||
    checkpoint.tenantId !== options.tenantId || checkpoint.destinationTable !== destinationTable ||
    !checkpoint.accounts || typeof checkpoint.accounts !== "object"
  ) {
    throw new MigrationCliError("Migration checkpoint does not match this tenant and destination.", 2);
  }
  return checkpoint;
}

function writeJsonAtomic(filePath: string, value: unknown) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, filePath);
}

interface PoolOutcome {
  task: Promise<PoolOutcome>;
  error?: unknown;
}

async function runStreamingPool<T>(
  items: AsyncIterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>
) {
  const active = new Set<Promise<PoolOutcome>>();
  const settleOne = async () => {
    const outcome = await Promise.race(active);
    active.delete(outcome.task);
    if (outcome.error !== undefined) throw outcome.error;
  };
  try {
    for await (const item of items) {
      let task!: Promise<PoolOutcome>;
      task = worker(item).then(
        () => ({ task }),
        (error: unknown) => ({ task, error })
      );
      active.add(task);
      if (active.size >= concurrency) await settleOne();
    }
    while (active.size > 0) await settleOne();
  } catch (error) {
    await Promise.allSettled(active);
    throw error;
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new MigrationCliError(`${name} is required.`, 2);
  return value;
}

function isProduction() {
  return process.env.NODE_ENV === "production" || process.env.RULIX_ENV === "production";
}

main().catch((error: unknown) => {
  const exitCode = error instanceof MigrationCliError
    ? error.exitCode
    : error instanceof WorkspaceConflictError || error instanceof WorkspaceContentGcActiveError
      ? 3
      : error instanceof WorkspaceValidationError || error instanceof WorkspaceIntegrityError
        ? 2
        : 4;
  const message = error instanceof Error ? error.message : "Unknown migration failure.";
  process.stderr.write(`${JSON.stringify({ error: message, exitCode })}\n`);
  process.exitCode = exitCode;
});
