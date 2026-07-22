import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deterministicCouncilClient } from "../e2e/fixtures/deterministicCouncil";

const port = 8789;
const storePath = path.join(os.tmpdir(), `rulix-playwright-${process.pid}.json`);

process.env.AUTH_BOOTSTRAP_SECRET = "rulix-e2e-bootstrap";
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.RULIX_STORE_PATH = storePath;
process.env.BEDROCK_ENABLED = "true";
process.env.AWS_REGION = "us-east-1";
process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
process.env.RULIX_APPROVED_REGION = "us-east-1";
process.env.RULIX_AI_DATA_CLASS = "proprietary";

rmSync(storePath, { force: true });

const { createApp } = await import("../server/app");
const server = createApp({ aiProviderClient: deterministicCouncilClient }).listen(port, "127.0.0.1", () => {
  console.log(`Rulix Playwright server listening on http://127.0.0.1:${port}`);
});

const shutdown = () => {
  server.close(() => {
    rmSync(storePath, { force: true });
    process.exit(0);
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
