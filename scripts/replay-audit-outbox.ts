import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  DescribeTableCommand,
  DynamoDBClient,
  ScanCommand,
  type AttributeValue
} from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { parseAuditStreamRecord } from "../server/auditLambda";

type RawItem = Record<string, AttributeValue>;

interface ReplayOptions {
  mode: "plan" | "apply";
  confirmFunction?: string;
}

export function buildAuditReplayRecord(
  item: RawItem,
  streamArn: string,
  region: string,
  index: number
): DynamoDBRecord {
  const pk = item.pk;
  const sk = item.sk;
  if (!pk?.S || !sk?.S) throw new Error("Audit outbox item is missing string pk/sk keys.");
  const stableId = createHash("sha256").update(`${pk.S}\u0000${sk.S}`).digest("hex");
  const createdAt = item.createdAt?.S;
  const createdAtEpoch = createdAt ? Date.parse(createdAt) / 1_000 : Date.now() / 1_000;
  return {
    eventID: `audit-replay-${stableId}`,
    eventName: "INSERT",
    eventSource: "aws:dynamodb",
    eventSourceARN: streamArn,
    awsRegion: region,
    dynamodb: {
      ApproximateCreationDateTime: Number.isFinite(createdAtEpoch)
        ? createdAtEpoch
        : Date.now() / 1_000,
      Keys: { pk, sk } as NonNullable<DynamoDBRecord["dynamodb"]>["Keys"],
      NewImage: item as NonNullable<DynamoDBRecord["dynamodb"]>["NewImage"],
      SequenceNumber: String(index + 1).padStart(40, "0"),
      SizeBytes: Buffer.byteLength(JSON.stringify(item), "utf8"),
      StreamViewType: "NEW_IMAGE"
    }
  };
}

export function assertAuditReplayResponse(response: {
  FunctionError?: string;
  Payload?: Uint8Array;
  StatusCode?: number;
}) {
  if (response.StatusCode !== 200 || response.FunctionError) {
    throw new Error(`Audit replay invocation failed (${response.StatusCode ?? "unknown"}/${response.FunctionError ?? "none"}).`);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(response.Payload));
  } catch {
    throw new Error("Audit replay invocation returned malformed JSON.");
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { batchItemFailures?: unknown }).batchItemFailures)) {
    throw new Error("Audit replay invocation returned an invalid batch response.");
  }
  const failures = (body as { batchItemFailures: unknown[] }).batchItemFailures;
  if (failures.length > 0) {
    throw new Error(`Audit replay consumer rejected ${failures.length} outbox record(s).`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const region = requiredEnvironment("AWS_REGION");
  const tenantId = requiredEnvironment("RULIX_TENANT_ID");
  const workspaceTable = requiredEnvironment("RULIX_WORKSPACE_TABLE");
  const auditFunction = requiredEnvironment("RULIX_AUDIT_WRITER_FUNCTION");
  if (options.mode === "apply" && options.confirmFunction !== auditFunction) {
    throw new Error(`Apply requires --confirm-function ${auditFunction}.`);
  }

  const dynamo = new DynamoDBClient({ region });
  const lambda = new LambdaClient({ region });
  const table = await dynamo.send(new DescribeTableCommand({ TableName: workspaceTable }));
  const streamArn = table.Table?.LatestStreamArn;
  if (!streamArn) throw new Error(`${workspaceTable} does not expose an active DynamoDB stream.`);
  const items = await listAuditOutboxItems(dynamo, workspaceTable, tenantId);
  const records = items.map((item, index) => {
    const record = buildAuditReplayRecord(item, streamArn, region, index);
    parseAuditStreamRecord(record, tenantId, streamArn);
    return record;
  });
  const accounts = new Set(items.map((item) => item.pk?.S).filter(Boolean)).size;

  if (options.mode === "apply") {
    for (let start = 0; start < records.length; start += 10) {
      const event: DynamoDBStreamEvent = { Records: records.slice(start, start + 10) };
      const response = await lambda.send(new InvokeCommand({
        FunctionName: auditFunction,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(event), "utf8")
      }));
      assertAuditReplayResponse(response);
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: options.mode,
    tenantId,
    workspaceTable,
    auditFunction,
    accounts,
    records: records.length,
    batches: Math.ceil(records.length / 10),
    status: options.mode === "apply" ? "replayed" : "validated"
  })}\n`);
}

async function listAuditOutboxItems(client: DynamoDBClient, tableName: string, tenantId: string) {
  const items: RawItem[] = [];
  let exclusiveStartKey: RawItem | undefined;
  do {
    const response = await client.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      FilterExpression: "begins_with(#pk, :tenant) AND begins_with(#sk, :audit) AND #entityType = :entityType",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#entityType": "entityType" },
      ExpressionAttributeValues: {
        ":tenant": { S: `TENANT#${encodeURIComponent(tenantId)}#USER#` },
        ":audit": { S: "AU#" },
        ":entityType": { S: "AU" }
      },
      ExclusiveStartKey: exclusiveStartKey
    }));
    items.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.sort((left, right) =>
    `${left.pk?.S ?? ""}\u0000${left.sk?.S ?? ""}`.localeCompare(
      `${right.pk?.S ?? ""}\u0000${right.sk?.S ?? ""}`
    ));
}

function parseArgs(args: string[]): ReplayOptions {
  const mode = argumentValue(args, "--mode") ?? "plan";
  if (mode !== "plan" && mode !== "apply") throw new Error("--mode must be plan or apply.");
  return { mode, confirmFunction: argumentValue(args, "--confirm-function") };
}

function argumentValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
