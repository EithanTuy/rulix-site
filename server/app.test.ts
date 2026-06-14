// @vitest-environment node

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sampleMemos } from "../src/data/sampleMemos";
import { createApp } from "./app";

const originalKey = process.env.ANTHROPIC_API_KEY;

describe("Rulix ECCN API", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("reports health and whether the Anthropic backend is configured", async () => {
    const response = await request(createApp()).get("/api/health").expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("rulix-eccn-api");
    expect(response.body.provider.configured).toBe(false);
  });

  it("serves the official corpus snapshot", async () => {
    const response = await request(createApp()).get("/api/corpus").expect(200);

    expect(response.body.id).toBe("official-corpus-2026-06-seed");
    expect(response.body.chunks.length).toBeGreaterThan(3);
  });

  it("analyzes an ad hoc memo through the fallback backend path", async () => {
    const response = await request(createApp())
      .post("/api/ai/review")
      .send({ memo: sampleMemos[0] })
      .expect(200);

    expect(response.body.result.memoId).toBe(sampleMemos[0].id);
    expect(response.body.result.recommended.eccn).toBe("3A001.a.5");
    expect(response.body.result.provider.source).toBe("local-rules");
  });

  it("records a reviewer decision", async () => {
    const memoId = sampleMemos[0].id;
    const response = await request(createApp())
      .post(`/api/reviews/${memoId}/decision`)
      .send({ action: "request-info", notes: "Need vendor parameter mapping." })
      .expect(200);

    expect(response.body.review.status).toBe("needs-info");
    expect(response.body.decision.notes).toContain("vendor parameter");
  });
});
