import serverless from "serverless-http";
import { createApp } from "./app";
import { processOutreachJob, type OutreachWorkerEvent } from "./outreachJobs";

// AWS Lambda entrypoint: the same Express app (UI + /api) wrapped for the
// Lambda runtime and exposed via a Function URL. Binary asset types are listed
// so the bundled Vite client (JS/CSS/fonts) is returned correctly.
const handlerFn = serverless(createApp(), {
  binary: [
    "application/octet-stream",
    "image/*",
    "font/*",
    "application/font-woff",
    "application/font-woff2"
  ]
});

export const handler = async (event: unknown, context: unknown) => {
  if (
    typeof event === "object" &&
    event !== null &&
    (event as Partial<OutreachWorkerEvent>).source === "rulix.outreach-worker"
  ) {
    await processOutreachJob(event as OutreachWorkerEvent);
    return { ok: true };
  }
  return handlerFn(event, context);
};
