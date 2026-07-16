import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const port = 8789;
const storePath = path.join(os.tmpdir(), `rulix-playwright-${process.pid}.json`);

process.env.AUTH_BOOTSTRAP_SECRET = "rulix-e2e-bootstrap";
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.RULIX_STORE_PATH = storePath;
process.env.BEDROCK_ENABLED = "false";

rmSync(storePath, { force: true });

const { createApp } = await import("../server/app");
const server = createApp().listen(port, "127.0.0.1", () => {
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
