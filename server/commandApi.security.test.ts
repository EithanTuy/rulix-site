// @vitest-environment node

import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { reviewFixtures } from "../src/test/reviewFixtures";
import type { AuditEvent, MemoChatMessage, MemoRecord, UserProfile } from "../src/types";
import { createApp } from "./app";
import { LocalAccountStore } from "./store";

describe("scoped review command API", () => {
  it.each([
    "review-command-compatibility",
    "paste-1782080000000",
    "upload-1782080000000",
    "ai-draft-1782080000000"
  ])("keeps durable current and migrated review IDs usable across command surfaces: %s", async (reviewId) => {
    const session = await signedIn(`compat-${reviewId.split("-")[0]}@example.com`);
    const created = await createReview(session);
    await session.store.upsertReview(session.user.id, {
      ...created.review,
      id: reviewId,
      documentCode: `LEGACY-${reviewId.split("-")[0].toUpperCase()}`,
      contentHash: undefined
    });

    const detail = await session.agent.get(`/api/reviews/${reviewId}`).expect(200);
    await session.agent.get(`/api/reviews/${reviewId}/audit?limit=25`).expect(200);
    await session.agent.get(`/api/reviews/${reviewId}/chat?limit=25`).expect(200);

    const preference = await session.agent
      .patch("/api/account/preferences")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ expectedVersion: 0, selectedMemoId: reviewId })
      .expect(200);
    expect(preference.body.selectedMemoId).toBe(reviewId);

    const sessionId = `builder-${randomUUID()}`;
    await session.agent
      .put(`/api/account/memo-builder/sessions/${sessionId}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        expectedVersion: 0,
        session: {
          id: sessionId,
          title: "Improve an existing review",
          dataClass: "proprietary",
          updatedAt: new Date().toISOString(),
          contextMemoId: reviewId,
          messages: [],
          draft: {
            title: "Improved memo",
            itemFamily: "Cryogenic controller",
            dataClass: "proprietary",
            memoText: "# Improved memo\n\nReview-ready content.",
            source: "review-improvement",
            reviewContextMemoId: reviewId
          }
        }
      })
      .expect(200);

    const approval = await session.agent
      .post("/api/ai-approval-requests")
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        requestId: randomUUID(),
        purpose: "council",
        reviewId,
        depth: "standard",
        ...bindings(detail.body.review)
      })
      .expect(503);
    expect(approval.body.code).toBe("ai_provider_unavailable");

    const edited = await session.agent
      .patch(`/api/reviews/${reviewId}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        memoText: `${detail.body.review.memoText}\n\nCompatibility path verified.`,
        ...bindings(detail.body.review)
      })
      .expect(200);
    expect(edited.body.review.id).toBe(reviewId);
  });

  it("creates idempotently from a normalized server hash and rejects request-ID reuse", async () => {
    const session = await signedIn("idempotency@example.com");
    const payload = reviewInput();

    const created = await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send(payload)
      .expect(201);
    const replayed = await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send(payload)
      .expect(200);

    expect(replayed.body).toMatchObject({
      replayed: true,
      review: { id: created.body.review.id, contentHash: created.body.review.contentHash }
    });
    expect(created.body.replayed).toBe(false);

    const conflict = await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ ...payload, memoText: `${payload.memoText}\n\nDifferent normalized payload.` })
      .expect(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
  });

  it("rejects missing, malformed, empty, and oversized create commands", async () => {
    const session = await signedIn("create-validation@example.com");

    await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ ...reviewInput(), requestId: "not-a-uuid" })
      .expect(400);
    await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ ...reviewInput(), memoText: "   " })
      .expect(400);
    const oversized = await session.agent
      .post("/api/reviews")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ ...reviewInput(), memoText: "x".repeat(270 * 1024) })
      .expect(413);
    expect(oversized.body.code).toBe("request_body_too_large");
  });

  it("pages summary-only review lists and separates active from archived state", async () => {
    const session = await signedIn("review-pages@example.com");
    const reviews: MemoRecord[] = [];
    for (const suffix of ["one", "two", "three"]) {
      const response = await session.agent
        .post("/api/reviews")
        .set("x-rulix-csrf", session.csrfToken)
        .send({ ...reviewInput(), requestId: randomUUID(), title: `Review ${suffix}` })
        .expect(201);
      reviews.push(response.body.review);
    }

    const firstPage = await session.agent.get("/api/reviews?limit=2&state=active").expect(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(firstPage.body.items[0]).not.toHaveProperty("memoText");
    expect(firstPage.body.items[0]).not.toHaveProperty("attachments");

    const secondPage = await session.agent
      .get(`/api/reviews?limit=2&state=active&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    const ids = [...firstPage.body.items, ...secondPage.body.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);

    const archived = await session.agent
      .patch(`/api/reviews/${reviews[0].id}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ archived: true, ...bindings(reviews[0]) })
      .expect(200);
    expect(archived.body.review.archivedAt).toEqual(expect.any(String));

    const activePage = await session.agent.get("/api/reviews?limit=50&state=active").expect(200);
    const archivePage = await session.agent.get("/api/reviews?limit=50&state=archived").expect(200);
    expect(activePage.body.items.map((item: { id: string }) => item.id)).not.toContain(reviews[0].id);
    expect(archivePage.body.items.map((item: { id: string }) => item.id)).toContain(reviews[0].id);
    await session.agent.get("/api/reviews?limit=51").expect(400);
    await session.agent.get("/api/reviews?state=deleted").expect(400);
  });

  it("binds edits to the displayed review and emits authoritative provenance", async () => {
    const session = await signedIn("bound-edit@example.com");
    const created = await createReview(session);
    expectAuthoritativeAudit(created.auditEvents[0], session.user, created.review.id);

    const updated = await session.agent
      .patch(`/api/reviews/${created.review.id}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ memoText: `${created.review.memoText}\n\nReviewer clarification.`, ...bindings(created.review) })
      .expect(200);
    expect(updated.body.review.revision).toBe(bindings(created.review).expectedRevision + 1);
    expectAuthoritativeAudit(updated.body.auditEvents[0], session.user, created.review.id);

    const stale = await session.agent
      .patch(`/api/reviews/${created.review.id}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ archived: true, ...bindings(created.review) })
      .expect(409);
    expect(stale.body.code).toBe("stale_revision");

    await session.agent
      .patch(`/api/reviews/${created.review.id}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ memoText: "Forged", archived: true, ...bindings(updated.body.review) })
      .expect(400);
  });

  it("keeps preferences and builder sessions independently versioned", async () => {
    const session = await signedIn("preferences-builder@example.com");
    const created = await createReview(session);

    const preference = await session.agent
      .patch("/api/account/preferences")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ expectedVersion: 0, selectedMemoId: created.review.id })
      .expect(200);
    expect(preference.body).toMatchObject({ version: 1, selectedMemoId: created.review.id });
    const stalePreference = await session.agent
      .patch("/api/account/preferences")
      .set("x-rulix-csrf", session.csrfToken)
      .send({ expectedVersion: 0, selectedMemoId: null })
      .expect(409);
    expect(stalePreference.body.code).toBe("stale_preferences");

    const sessionId = `builder-${randomUUID()}`;
    const builder = {
      id: sessionId,
      title: "Bounded builder chat",
      dataClass: "proprietary",
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "Draft a classification memo." }]
    };
    const stored = await session.agent
      .put(`/api/account/memo-builder/sessions/${sessionId}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ expectedVersion: 0, session: builder })
      .expect(200);
    expect(stored.body.version).toBe(1);

    await session.agent
      .put(`/api/account/memo-builder/sessions/${sessionId}`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        expectedVersion: 1,
        session: {
          ...builder,
          pendingAttachments: [{ id: "raw", name: "secret.txt", content: "raw secret", status: "ready", detail: "" }]
        }
      })
      .expect(400);

    const reviewPage = await session.agent.get("/api/reviews?limit=50&state=all").expect(200);
    expect(reviewPage.body.items.map((item: { id: string }) => item.id)).toContain(created.review.id);
  });

  it("applies only a stored, review-bound chat suggestion by message ID", async () => {
    const session = await signedIn("chat-apply@example.com");
    const created = await createReview(session);
    const suggestedText = `${created.review.memoText}\n\nServer-stored suggested clarification.`;
    const message: MemoChatMessage = {
      id: `chat-${randomUUID()}`,
      memoId: created.review.id,
      role: "assistant",
      text: "I drafted a clarification.",
      proposedMemoText: suggestedText,
      createdAt: new Date().toISOString(),
      memoRevision: created.review.revision,
      memoVersion: created.review.version,
      memoHash: created.review.contentHash
    };
    await session.store.appendBoundChat(session.user.id, created.review.id, {
      ...bindings(created.review),
      messages: [message]
    });

    await session.agent
      .post(`/api/reviews/${created.review.id}/chat/${message.id}/apply`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        expectedVersion: created.review.version,
        expectedHash: created.review.contentHash,
        proposedMemoText: "Client-forged replacement"
      })
      .expect(400);

    const applied = await session.agent
      .post(`/api/reviews/${created.review.id}/chat/${message.id}/apply`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({ expectedVersion: created.review.version, expectedHash: created.review.contentHash })
      .expect(200);
    expect(applied.body.review.memoText).toBe(suggestedText);
    expect(applied.body.messages.find((item: MemoChatMessage) => item.id === message.id)?.applied).toBe(true);
    expectAuthoritativeAudit(applied.body.auditEvents[0], session.user, created.review.id);

    await session.agent
      .post(`/api/reviews/${created.review.id}/chat/chat-${randomUUID()}/apply`)
      .set("x-rulix-csrf", session.csrfToken)
      .send({
        expectedVersion: applied.body.review.version,
        expectedHash: applied.body.review.contentHash
      })
      .expect(404);
  });
});

async function signedIn(email: string) {
  const store = new LocalAccountStore({ persist: false });
  const app = createApp({ store });
  const agent = request.agent(app);
  const invite = await store.createInvite({ email, name: "Command Reviewer", role: "reviewer" });
  const response = await agent
    .post("/api/auth/invite/accept")
    .send({ token: invite.rawToken, password: "Correct-Horse-2026" })
    .expect(201);
  return {
    agent,
    store,
    csrfToken: response.body.csrfToken as string,
    user: response.body.user as UserProfile
  };
}

function reviewInput() {
  return {
    requestId: randomUUID(),
    title: "RLX-200 controller review",
    itemFamily: "Cryogenic controller",
    manufacturer: "Rulix Test Instruments",
    intendedUse: "University research laboratory",
    dataClass: "proprietary",
    sourcePath: "self-classification",
    memoText: reviewFixtures[0].memoText,
    attachments: []
  };
}

async function createReview(session: Awaited<ReturnType<typeof signedIn>>) {
  const response = await session.agent
    .post("/api/reviews")
    .set("x-rulix-csrf", session.csrfToken)
    .send(reviewInput())
    .expect(201);
  return response.body as { review: MemoRecord; auditEvents: AuditEvent[]; replayed: false };
}

function bindings(review: MemoRecord) {
  if (
    !Number.isSafeInteger(review.version)
    || !Number.isSafeInteger(review.revision)
    || typeof review.contentHash !== "string"
  ) {
    throw new Error(`Review ${review.id} is missing integrity bindings.`);
  }
  return {
    expectedVersion: review.version!,
    expectedRevision: review.revision!,
    expectedHash: review.contentHash
  };
}

function expectAuthoritativeAudit(event: AuditEvent, user: UserProfile, memoId: string) {
  expect(event).toMatchObject({
    actorId: user.id,
    organizationId: user.organizationId ?? user.id,
    memoId,
    metadata: {
      actorType: "user",
      source: "authenticated-api",
      outcome: "succeeded",
      subjectType: "review",
      subjectId: memoId
    }
  });
}
