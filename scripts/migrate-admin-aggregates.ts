import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoAccountStore } from "../server/store";

async function main() {
  const authTable = requiredEnvironment("RULIX_AUTH_TABLE");
  const accountTable = requiredEnvironment("RULIX_ACCOUNT_TABLE");
  const tenantId = requiredEnvironment("RULIX_TENANT_ID");
  const confirmation = argumentValue("--confirm-table");
  if (confirmation !== authTable) {
    throw new Error(`Refusing to write until --confirm-table ${authTable} is supplied.`);
  }
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true }
  });
  const store = new DynamoAccountStore(authTable, accountTable, { client, tenantId });
  const result = await store.backfillAdminAggregates();
  process.stdout.write(`${JSON.stringify({ authTable, tenantId, ...result }, null, 2)}\n`);
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
