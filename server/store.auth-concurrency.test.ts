// @vitest-environment node

import { createHash } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../src/types";
import {
  DynamoAccountStore,
  LocalAccountStore,
  StoreError,
  type AuthSession
} from "./store";
import { WorkspaceCursorCodec } from "./workspaceV2";
import {
  ADMIN_METRICS_SCHEMA_VERSION,
  addUsageToAdminDailyAggregate
} from "./adminMetricsAggregates";
import { ADMIN_AGGREGATE_SCHEMA_VERSION } from "./adminAggregates";

const OLD_PASSWORD = "Correct-Horse-2026";
const NEW_PASSWORD = "Reset-Horse-2026";
const AUTH_TABLE = "auth";
const ACCOUNT_TABLE = "accounts";

describe("authentication state concurrency", () => {
  it("rejects a stale successful login after password reset commits", async () => {
    const { client, store } = await dynamoAccount("stale-login@example.com");
    const reset = await store.requestPasswordReset("stale-login@example.com");
    const pause = client.pauseBefore(isStandaloneUserMutation);

    const staleLogin = store.authenticate("stale-login@example.com", OLD_PASSWORD);
    await pause.reached;
    const resetSession = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);
    pause.release();

    await expectStoreStatus(staleLogin, 401);
    await expectStoreStatus(store.authenticate("stale-login@example.com", OLD_PASSWORD), 401);
    expect(await store.getSession(resetSession.rawToken)).toBeDefined();
    expect((await store.authenticate("stale-login@example.com", NEW_PASSWORD)).user.email)
      .toBe("stale-login@example.com");
  });

  it("does not let stale failed-login bookkeeping restore reset credentials", async () => {
    const { client, store } = await dynamoAccount("stale-failure@example.com");
    const reset = await store.requestPasswordReset("stale-failure@example.com");
    const pause = client.pauseBefore(isStandaloneUserMutation);

    const staleFailure = store.authenticate("stale-failure@example.com", "Wrong-Horse-2026");
    await pause.reached;
    const resetSession = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);
    pause.release();

    await expectStoreStatus(staleFailure, 401);
    expect(await store.getSession(resetSession.rawToken)).toBeDefined();
    await expectStoreStatus(store.authenticate("stale-failure@example.com", OLD_PASSWORD), 401);
    expect((await store.authenticate("stale-failure@example.com", NEW_PASSWORD)).user.email)
      .toBe("stale-failure@example.com");
  });

  it("does not resurrect a session when refresh loses a race with logout", async () => {
    const { client, store, initialSession } = await dynamoAccount("refresh-logout@example.com");
    const pause = client.pauseBefore((event) =>
      event.name === "GetCommand" && event.input.Key?.sk === "USER#refresh-logout@example.com"
    );

    const refresh = store.getSession(initialSession.rawToken);
    await pause.reached;
    await store.destroySession(initialSession.rawToken);
    pause.release();

    expect(await refresh).toBeUndefined();
    expect(await store.getSession(initialSession.rawToken)).toBeUndefined();
  });

  it("keeps recent session checks read-only while validating the session and user strongly", async () => {
    const { client, store, initialSession } = await dynamoAccount("read-only-session@example.com");
    const sessionKey = `SESSION#${tokenHash(initialSession.rawToken)}`;
    const before = client.authRecord(sessionKey);
    const transactionsBefore = client.commandCount("TransactWriteCommand");
    const getsBefore = client.commandCount("GetCommand");

    const authenticated = await store.getSession(initialSession.rawToken);

    expect(authenticated?.session.lastSeenAt).toBe(before.lastSeenAt);
    expect(client.authRecord(sessionKey).lastSeenAt).toBe(before.lastSeenAt);
    expect(client.commandCount("TransactWriteCommand")).toBe(transactionsBefore);
    expect(client.commandCount("GetCommand") - getsBefore).toBe(3);
  });

  it("touches stale sessions and their admin aggregate in one transaction", async () => {
    const { client, store, initialSession } = await dynamoAccount("stale-session-touch@example.com");
    const token = tokenHash(initialSession.rawToken);
    const staleAt = new Date(Date.now() - 61_000).toISOString();
    client.setSessionLastSeenAt(token, staleAt);
    const transactionsBefore = client.commandCount("TransactWriteCommand");

    const authenticated = await store.getSession(initialSession.rawToken);

    expect(Date.parse(authenticated!.session.lastSeenAt)).toBeGreaterThan(Date.parse(staleAt));
    expect(client.commandCount("TransactWriteCommand")).toBe(transactionsBefore + 1);
    expect(client.adminSessionLastSeenAt(token)).toBe(authenticated!.session.lastSeenAt);
  });

  it("rejects a recent session immediately when the user auth generation changes", async () => {
    const email = "recent-session-revoked@example.com";
    const { client, store, initialSession } = await dynamoAccount(email);
    const token = tokenHash(initialSession.rawToken);
    client.incrementUserAuthGeneration(email);

    expect(await store.getSession(initialSession.rawToken)).toBeUndefined();
    expect(client.authRecord(`SESSION#${token}`)).toBeUndefined();
  });

  it("rejects an old-generation session insertion that loses a race with reset", async () => {
    const { client, store } = await dynamoAccount("late-session@example.com");
    const reset = await store.requestPasswordReset("late-session@example.com");
    const pause = client.pauseBefore(isSessionCreation);

    const staleLogin = store.authenticate("late-session@example.com", OLD_PASSWORD);
    await pause.reached;
    const resetSession = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);
    pause.release();

    await expectStoreStatus(staleLogin, 401);
    expect(await store.getSession(resetSession.rawToken)).toBeDefined();
    await expectStoreStatus(store.authenticate("late-session@example.com", OLD_PASSWORD), 401);
  });

  it("serializes six concurrent failed-login transitions without losing increments", async () => {
    const { client, store } = await dynamoAccount("lockout-race@example.com");
    client.barrierAfter(
      (event) => event.name === "GetCommand" && event.input.Key?.sk === "USER#lockout-race@example.com",
      6
    );

    const failures = await Promise.allSettled(
      Array.from({ length: 6 }, () => store.authenticate("lockout-race@example.com", "Wrong-Horse-2026"))
    );

    expect(failures).toHaveLength(6);
    for (const result of failures) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ status: 401 });
      }
    }
    const user = client.authRecord("USER#lockout-race@example.com");
    expect(user.failedAttempts).toBe(6);
    expect(Date.parse(user.lockedUntil)).toBeGreaterThan(Date.now());
    await expectStoreStatus(store.authenticate("lockout-race@example.com", OLD_PASSWORD), 429);
  });

  it("preserves normal Dynamo login, reset, revocation, and logout behavior", async () => {
    const { store, initialSession } = await dynamoAccount("dynamo-control@example.com");
    const login = await store.authenticate("dynamo-control@example.com", OLD_PASSWORD);

    expect(await store.getSession(initialSession.rawToken)).toBeDefined();
    expect(await store.getSession(login.rawToken)).toBeDefined();

    const reset = await store.requestPasswordReset("dynamo-control@example.com");
    const resetSession = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);

    expect(await store.getSession(initialSession.rawToken)).toBeUndefined();
    expect(await store.getSession(login.rawToken)).toBeUndefined();
    expect(await store.getSession(resetSession.rawToken)).toBeDefined();
    await expectStoreStatus(store.authenticate("dynamo-control@example.com", OLD_PASSWORD), 401);
    expect((await store.authenticate("dynamo-control@example.com", NEW_PASSWORD)).user.email)
      .toBe("dynamo-control@example.com");

    await store.destroySession(resetSession.rawToken);
    expect(await store.getSession(resetSession.rawToken)).toBeUndefined();
  });

  it("migrates legacy generation-zero users and sessions without failing open after reset", async () => {
    const { client, store, initialSession } = await dynamoAccount("legacy-generation@example.com");
    client.removeAuthGeneration("legacy-generation@example.com");

    expect(await store.getSession(initialSession.rawToken)).toBeDefined();
    const reset = await store.requestPasswordReset("legacy-generation@example.com");
    const resetSession = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);

    expect(await store.getSession(initialSession.rawToken)).toBeUndefined();
    expect(await store.getSession(resetSession.rawToken)).toBeDefined();
    await expectStoreStatus(store.authenticate("legacy-generation@example.com", OLD_PASSWORD), 401);
  });

  it("atomically consumes one invite exactly once under concurrent acceptance", async () => {
    const client = new InMemoryDynamoDocumentClient();
    const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    const email = "invite-race@example.com";
    const invite = await store.createInvite({ email, name: "First Name" });
    client.barrierAfter(
      (event) => event.name === "GetCommand"
        && event.input.Key?.sk === `INVITE#${tokenHash(invite.rawToken)}`,
      2
    );

    const outcomes = await Promise.allSettled([
      store.acceptInvite(invite.rawToken, OLD_PASSWORD, "Winner One"),
      store.acceptInvite(invite.rawToken, OLD_PASSWORD, "Winner Two")
    ]);

    const winners = outcomes.filter(
      (result): result is PromiseFulfilledResult<AuthSession> => result.status === "fulfilled"
    );
    const losers = outcomes.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ status: 410 });
    expect(await store.getSession(winners[0].value.rawToken)).toBeDefined();
    expect(client.authItems(`USER#${email}`)).toHaveLength(1);
    expect(client.authItems("SESSION#")).toHaveLength(1);
    expect(client.authItems("INVITE_EMAIL#")).toHaveLength(0);
    expect(client.authItems("INVITE#")[0]?.record).toMatchObject({ status: "used" });
    expect(client.tableItems(ACCOUNT_TABLE)).toHaveLength(1);
  });

  it("uses an email reservation so concurrent invite creation yields one pending token", async () => {
    const client = new InMemoryDynamoDocumentClient();
    const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    const email = "invite-create-race@example.com";
    client.barrierAfter(
      (event) => event.name === "QueryCommand"
        && event.input.ExpressionAttributeValues?.[":prefix"] === "INVITE#",
      2
    );

    const outcomes = await Promise.allSettled([
      store.createInvite({ email, name: "Invite One" }),
      store.createInvite({ email, name: "Invite Two" })
    ]);

    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ status: 409 });
    expect(client.authItems("INVITE#")).toHaveLength(1);
    expect(client.authItems(`INVITE_EMAIL#${email}`)).toHaveLength(1);
  });

  it("uses direct reset ownership lookup while exhausting every session-revocation page", async () => {
    const client = new InMemoryDynamoDocumentClient();
    const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    for (const email of ["aa-one@example.com", "mm-two@example.com", "yy-three@example.com"]) {
      await inviteAndAccept(store, email);
    }
    const targetEmail = "zz-target@example.com";
    const first = await inviteAndAccept(store, targetEmail);
    const targetId = first.user.id;
    await store.authenticate(targetEmail, OLD_PASSWORD);
    await store.authenticate(targetEmail, OLD_PASSWORD);
    expect(client.sessionsForUser(targetId)).toHaveLength(3);

    const reset = await store.requestPasswordReset(targetEmail);
    client.setQueryPageSize(2);
    expect((await store.getPasswordResetByToken(reset.rawToken!)).email).toBe(targetEmail);
    const replacement = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);

    expect(client.queryPageCount("USER#")).toBe(0);
    expect(client.queryPageCount("SESSION#")).toBeGreaterThan(1);
    expect(client.sessionsForUser(targetId)).toHaveLength(1);
    expect(await store.getSession(replacement.rawToken)).toBeDefined();
    expect(await store.getSession(first.rawToken)).toBeUndefined();
  });

  it("rejects oversized auth inputs before password hashing with generic login errors", async () => {
    const store = new LocalAccountStore({ persist: false });
    const hugePassword = `Aa1!${"x".repeat(12 * 1024 * 1024)}`;
    const invite = await store.createInvite({ email: "bounded-auth@example.com", name: "Bounded" });

    await expectStoreStatus(store.acceptInvite(invite.rawToken, hugePassword), 400);
    const accepted = await store.acceptInvite(invite.rawToken, OLD_PASSWORD);
    expect(await store.getSession(accepted.rawToken)).toBeDefined();
    try {
      await store.authenticate("bounded-auth@example.com", hugePassword);
      throw new Error("Expected oversized authentication to fail.");
    } catch (error) {
      expect(error).toMatchObject({ status: 401, message: "Invalid email or password." });
    }
    await expectStoreStatus(
      store.createInvite({ email: `${"e".repeat(255)}@example.com` }),
      400
    );
    await expectStoreStatus(
      store.createInvite({ email: "long-name@example.com", name: "n".repeat(121) }),
      400
    );
  });

  it("places invite and reset secrets only in URL fragments", async () => {
    const store = new LocalAccountStore({ persist: false });
    const invite = await store.createInvite({ email: "fragment-links@example.com" });
    expect(invite.inviteLink).toContain(`/#invite=${encodeURIComponent(invite.rawToken)}`);
    expect(invite.inviteLink).not.toContain("?invite=");
    await store.acceptInvite(invite.rawToken, OLD_PASSWORD);
    const reset = await store.requestPasswordReset("fragment-links@example.com");
    expect(reset.resetLink).toContain(`/#reset=${encodeURIComponent(reset.rawToken!)}`);
    expect(reset.resetLink).not.toContain("?reset=");
  });

  it("applies the same generation semantics to the in-memory store", async () => {
    const store = new LocalAccountStore({ persist: false });
    const initialSession = await inviteAndAccept(store, "local-control@example.com");
    const login = await store.authenticate("local-control@example.com", OLD_PASSWORD);
    const reset = await store.requestPasswordReset("local-control@example.com");
    const resetSession = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);

    expect(await store.getSession(initialSession.rawToken)).toBeUndefined();
    expect(await store.getSession(login.rawToken)).toBeUndefined();
    expect(await store.getSession(resetSession.rawToken)).toBeDefined();
    await expectStoreStatus(store.authenticate("local-control@example.com", OLD_PASSWORD), 401);
    expect((await store.authenticate("local-control@example.com", NEW_PASSWORD)).user.email)
      .toBe("local-control@example.com");

    await store.destroySession(resetSession.rawToken);
    expect(await store.getSession(resetSession.rawToken)).toBeUndefined();
  });

  it("gates legacy admin data, then pages with a deployment-shared cursor across instances", async () => {
    const client = new InMemoryDynamoDocumentClient();
    const keyRing = { activeKeyId: "shared", keys: { shared: "s".repeat(32) } };
    const storeA = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient,
      adminCursors: new WorkspaceCursorCodec(keyRing)
    });
    const storeB = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient,
      adminCursors: new WorkspaceCursorCodec(keyRing)
    });
    for (const email of ["admin-a@example.com", "admin-b@example.com", "admin-c@example.com"]) {
      await inviteAndAccept(storeA, email);
    }

    await expectStoreStatus(storeA.listAdminUsersPage({ limit: 2 }), 503);
    await expect(storeA.backfillAdminAggregates()).resolves.toMatchObject({ status: "complete" });
    const first = await storeA.listAdminUsersPage({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await storeB.listAdminUsersPage({ limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((user) => user.email)).size).toBe(3);
    await expectStoreStatus(
      storeB.listAdminUsersPage({ limit: 2, cursor: `${first.nextCursor}tampered` }),
      400
    );
  });

  it("aggregates duplicate usage ids exactly once and rejects conflicting telemetry", async () => {
    const { store, initialSession } = await dynamoAccount("usage-idempotency@example.com");
    const event = usageEvent(initialSession.user.id, initialSession.user.email, "usage-same");
    await store.recordUsage(event);
    await store.recordUsage({ ...event });
    await store.backfillAdminAggregates();

    const page = await store.listAdminUsersPage({ limit: 10 });
    expect(page.items[0]?.usage.calls).toBe(1);
    expect(page.items[0]?.usage.inputTokens).toBe(event.inputTokens);
    expect((await store.getAdminMetrics(30)).totals.calls).toBe(1);
    await expectStoreStatus(store.recordUsage({ ...event, outputTokens: event.outputTokens + 1 }), 409);
  });

  it("serializes concurrent same-day usage into one exact materialized bucket", async () => {
    const { client, store, initialSession } = await dynamoAccount("metrics-race@example.com");
    await store.backfillAdminAggregates();
    const dayPrefix = `ADMIN_METRICS_DAY#${new Date().toISOString().slice(0, 10)}`;
    client.barrierAfter(
      (event) => event.name === "GetCommand" && event.input.Key?.sk === dayPrefix,
      2
    );

    await Promise.all([
      store.recordUsage(usageEvent(initialSession.user.id, initialSession.user.email, "race-a")),
      store.recordUsage(usageEvent(initialSession.user.id, initialSession.user.email, "race-b"))
    ]);

    const metrics = await store.getAdminMetrics(7);
    expect(metrics.totals.calls).toBe(2);
    expect(metrics.daily[metrics.daily.length - 1]?.calls).toBe(2);
    expect(client.authItems("ADMIN_METRICS_DAY#")).toHaveLength(1);
  });

  it("keeps the production metrics request bounded with a large tenant fixture", async () => {
    const client = new InMemoryDynamoDocumentClient();
    const today = new Date().toISOString();
    const daily = addUsageToAdminDailyAggregate(undefined, usageEvent(
      "fixture-user",
      "fixture@example.com",
      "fixture-usage"
    ));
    client.seedAuthRecord("ADMIN_AGGREGATES#v1", {
      schemaVersion: ADMIN_AGGREGATE_SCHEMA_VERSION,
      metricsSchemaVersion: ADMIN_METRICS_SCHEMA_VERSION,
      version: 2,
      status: "complete",
      startedAt: today,
      completedAt: today,
      usersTotal: 10_000
    });
    client.seedAuthRecord(`ADMIN_METRICS_DAY#${today.slice(0, 10)}`, daily);
    for (let index = 0; index < 10_000; index += 1) {
      client.seedAuthRecord(`USER#fixture-${String(index).padStart(5, "0")}@example.com`, {
        id: `user-${index}`,
        email: `fixture-${index}@example.com`
      });
      client.seedAuthRecord(`SESSION#fixture-${String(index).padStart(5, "0")}`, {
        userId: `user-${index}`,
        lastSeenAt: today,
        expiresAt: "2099-01-01T00:00:00.000Z"
      });
    }
    const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    const getsBefore = client.commandCount("GetCommand");
    const queriesBefore = client.commandCount("QueryCommand");

    const metrics = await store.getAdminMetrics(90);

    expect(metrics.users.total).toBe(10_000);
    expect(metrics.totals.calls).toBe(1);
    expect(client.commandCount("GetCommand") - getsBefore).toBe(1);
    expect(client.commandCount("QueryCommand") - queriesBefore).toBe(1);
    expect(client.queryPageCount("USER#")).toBe(0);
    expect(client.queryPageCount("SESSION#")).toBe(0);
    expect(client.queryPageCount("USAGE#")).toBe(0);
    expect(client.queryPageCount(`ADMIN_METRICS_DAY#${metrics.rangeStart}`)).toBe(1);
  });

  it("increments the exact materialized account count after migration", async () => {
    const { store } = await dynamoAccount("metrics-count-before@example.com");
    await store.backfillAdminAggregates();
    expect((await store.getAdminMetrics(7)).users.total).toBe(1);

    await inviteAndAccept(store, "metrics-count-after@example.com");

    expect((await store.getAdminMetrics(7)).users.total).toBe(2);
  });

  it("keeps admin activity exact through logout, reset revocation, and expiry", async () => {
    const { store, initialSession } = await dynamoAccount("session-admin@example.com");
    const second = await store.authenticate(initialSession.user.email, OLD_PASSWORD);
    await store.backfillAdminAggregates();

    expect((await store.listAdminUsersPage({ limit: 10 })).items[0]).toMatchObject({ online: true });
    await store.destroySession(initialSession.rawToken);
    expect((await store.listAdminUsersPage({ limit: 10 })).items[0]).toMatchObject({ online: true });

    const reset = await store.requestPasswordReset(initialSession.user.email);
    const replacement = await store.completePasswordReset(reset.rawToken!, NEW_PASSWORD);
    expect(await store.getSession(second.rawToken)).toBeUndefined();
    expect((await store.listAdminUsersPage({ limit: 10 })).items[0]).toMatchObject({ online: true });
    await store.destroySession(replacement.rawToken);
    expect((await store.listAdminUsersPage({ limit: 10 })).items[0]).toMatchObject({
      online: false,
      lastSeenAt: undefined
    });

    const previousTtl = process.env.AUTH_SESSION_TTL_HOURS;
    process.env.AUTH_SESSION_TTL_HOURS = "0.000001";
    try {
      const expiring = await store.authenticate(initialSession.user.email, NEW_PASSWORD);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await store.listAdminUsersPage({ limit: 10 })).items[0]).toMatchObject({ online: false });
      expect(await store.getSession(expiring.rawToken)).toBeUndefined();
    } finally {
      if (previousTtl === undefined) delete process.env.AUTH_SESSION_TTL_HOURS;
      else process.env.AUTH_SESSION_TTL_HOURS = previousTtl;
    }
  });

  it("backfills legacy usage and sessions before exposing totals", async () => {
    const { client, store, initialSession } = await dynamoAccount("legacy-admin@example.com");
    await store.recordUsage(usageEvent(initialSession.user.id, initialSession.user.email, "legacy-usage"));
    client.convertAdminDataToLegacy();

    await expectStoreStatus(store.listAdminUsersPage({ limit: 10 }), 503);
    const result = await store.backfillAdminAggregates();
    expect(result).toMatchObject({ usageEventsProcessed: 1, sessionsProcessed: 1 });
    const summary = (await store.listAdminUsersPage({ limit: 10 })).items[0];
    expect(summary.usage.calls).toBe(1);
    expect(summary.online).toBe(true);
  });

  it("fences concurrent backfills and makes a completed retry idempotent", async () => {
    const client = new InMemoryDynamoDocumentClient();
    const storeA = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    const storeB = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    const session = await inviteAndAccept(storeA, "metrics-backfill-race@example.com");
    await storeA.recordUsage(usageEvent(session.user.id, session.user.email, "backfill-race-usage"));
    client.convertAdminDataToLegacy();
    client.barrierAfter(
      (event) => event.name === "GetCommand" && event.input.Key?.sk === "ADMIN_AGGREGATES#v1",
      2
    );

    const attempts = await Promise.allSettled([
      storeA.backfillAdminAggregates(),
      storeB.backfillAdminAggregates()
    ]);

    expect(attempts.some((result) => result.status === "fulfilled")).toBe(true);
    await expect(storeB.backfillAdminAggregates()).resolves.toMatchObject({ status: "complete" });
    expect((await storeA.getAdminMetrics(7)).totals.calls).toBe(1);
    expect(client.authItems("ADMIN_METRICS_DAY#")).toHaveLength(1);
  });

  it("does not let a stale legacy backfill overwrite a concurrently refreshed session", async () => {
    const { client, store, initialSession } = await dynamoAccount("legacy-session-race@example.com");
    client.convertAdminDataToLegacy();
    client.setSessionLastSeenAt(
      tokenHash(initialSession.rawToken),
      new Date(Date.now() - 61_000).toISOString()
    );
    const pause = client.pauseBefore((event) =>
      event.name === "TransactWriteCommand" &&
      (event.input.TransactItems ?? []).some((item: CommandInput) =>
        item.Put?.Item?.sk === `SESSION#${tokenHash(initialSession.rawToken)}`
        && item.Put?.ConditionExpression?.includes(":expectedLastSeenAt")
      )
    );

    const backfill = store.backfillAdminAggregates();
    await pause.reached;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const refreshed = await store.getSession(initialSession.rawToken);
    expect(refreshed).toBeDefined();
    pause.release();
    await backfill;

    const persisted = client.authRecord(`SESSION#${tokenHash(initialSession.rawToken)}`);
    expect(persisted.lastSeenAt).toBe(refreshed!.session.lastSeenAt);
    expect((await store.listAdminUsersPage({ limit: 10 })).items[0]?.lastSeenAt)
      .toBe(refreshed!.session.lastSeenAt);
  });

  it("queries only the requested usage sort-key range and exhausts its pages", async () => {
    const { client, store, initialSession } = await dynamoAccount("usage-range@example.com");
    const recent = usageEvent(initialSession.user.id, initialSession.user.email, "recent");
    const old = { ...usageEvent(initialSession.user.id, initialSession.user.email, "old"), at: "2020-01-01T00:00:00.000Z" };
    await store.recordUsage(old);
    await store.recordUsage(recent);
    client.setQueryPageSize(1);

    const result = await store.getUsage(30);
    expect(result.map((event) => event.id)).toEqual(["recent"]);
    expect(client.lastUsageRange()).toMatchObject({ endSk: "USAGE#\uffff" });
    expect(client.lastUsageRange()?.startSk).toMatch(/^USAGE#\d{4}-/);
  });

  it("does not let a legacy credential scrub overwrite a concurrent provider selection", async () => {
    const client = new InMemoryDynamoDocumentClient();
    client.seedAuthRecord("CONFIG#outreach", {
      provider: "anthropic",
      anthropicApiKey: "legacy-plaintext"
    });
    const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
      client: client as unknown as DynamoDBDocumentClient
    });
    const pause = client.pauseBefore((event) =>
      event.name === "PutCommand" && event.input.Item?.sk === "CONFIG#outreach"
    );

    const scrub = store.getOutreachConfig();
    await pause.reached;
    await store.setOutreachConfig({ provider: "bedrock" });
    pause.release();

    await expect(scrub).resolves.toEqual({ provider: "bedrock" });
    expect(client.authRecord("CONFIG#outreach")).toEqual({ provider: "bedrock" });
  });
});

function usageEvent(userId: string, userEmail: string, id: string): UsageEvent {
  return {
    id,
    userId,
    userEmail,
    at: new Date().toISOString(),
    model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    callType: "council",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 50
  };
}

async function dynamoAccount(email: string) {
  const client = new InMemoryDynamoDocumentClient();
  const store = new DynamoAccountStore(AUTH_TABLE, ACCOUNT_TABLE, {
    client: client as unknown as DynamoDBDocumentClient
  });
  const initialSession = await inviteAndAccept(store, email);
  return { client, store, initialSession };
}

async function inviteAndAccept(
  store: Pick<DynamoAccountStore | LocalAccountStore, "createInvite" | "acceptInvite">,
  email: string
): Promise<AuthSession> {
  const invite = await store.createInvite({ email, name: "Security Test" });
  return store.acceptInvite(invite.rawToken, OLD_PASSWORD);
}

async function expectStoreStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    throw new Error(`Expected StoreError ${status}, but the operation succeeded.`);
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).status).toBe(status);
  }
}

type CommandInput = Record<string, any>;
type CommandEvent = { name: string; input: CommandInput };
type EventPredicate = (event: CommandEvent) => boolean;

function isStandaloneUserMutation(event: CommandEvent) {
  return (event.name === "PutCommand" && String(event.input.Item?.sk).startsWith("USER#"))
    || (event.name === "UpdateCommand" && String(event.input.Key?.sk).startsWith("USER#"));
}

function isSessionCreation(event: CommandEvent) {
  if (event.name === "PutCommand") {
    return String(event.input.Item?.sk).startsWith("SESSION#");
  }
  if (event.name !== "TransactWriteCommand") return false;
  return (event.input.TransactItems ?? []).some((item: CommandInput) =>
    String(item.Put?.Item?.sk).startsWith("SESSION#")
  );
}

class InMemoryDynamoDocumentClient {
  private items = new Map<string, CommandInput>();
  private beforeHooks: Array<(event: CommandEvent) => Promise<void>> = [];
  private afterHooks: Array<(event: CommandEvent) => Promise<void>> = [];
  private queryPageSize = Number.POSITIVE_INFINITY;
  private queryPages = new Map<string, number>();
  private usageRange?: { startSk: string; endSk: string };
  private commandCounts = new Map<string, number>();

  setQueryPageSize(size: number) {
    this.queryPageSize = size;
    this.queryPages.clear();
  }

  queryPageCount(prefix: string) {
    return this.queryPages.get(prefix) ?? 0;
  }

  lastUsageRange() {
    return this.usageRange;
  }

  commandCount(name: string) {
    return this.commandCounts.get(name) ?? 0;
  }

  setSessionLastSeenAt(tokenHash: string, lastSeenAt: string) {
    const session = this.items.get(itemKey(AUTH_TABLE, {
      pk: "TENANT#prod",
      sk: `SESSION#${tokenHash}`
    }));
    if (!session?.record) throw new Error("Expected session fixture.");
    session.record.lastSeenAt = lastSeenAt;
    for (const item of this.items.values()) {
      if (item.__table !== AUTH_TABLE || !String(item.sk).startsWith("ADMIN_SESSIONS#")) continue;
      if (item.record?.sessions?.[tokenHash]) item.record.sessions[tokenHash].lastSeenAt = lastSeenAt;
    }
  }

  adminSessionLastSeenAt(tokenHash: string) {
    for (const item of this.items.values()) {
      const entry = item.record?.sessions?.[tokenHash];
      if (item.__table === AUTH_TABLE && entry) return entry.lastSeenAt;
    }
    return undefined;
  }

  incrementUserAuthGeneration(email: string) {
    const user = this.items.get(itemKey(AUTH_TABLE, {
      pk: "TENANT#prod",
      sk: `USER#${email}`
    }));
    if (!user?.record) throw new Error("Expected user fixture.");
    user.record.authGeneration = (user.record.authGeneration ?? 0) + 1;
  }

  seedAuthRecord(sk: string, record: CommandInput) {
    const item = { pk: "TENANT#prod", sk, record: clone(record), __table: AUTH_TABLE };
    this.items.set(itemKey(AUTH_TABLE, item), item);
  }

  convertAdminDataToLegacy() {
    for (const [key, item] of this.items.entries()) {
      const sk = String(item.sk ?? "");
      if (sk.startsWith("ADMIN_") || sk.startsWith("USAGE_RECEIPT#")) {
        this.items.delete(key);
        continue;
      }
      if (sk.startsWith("SESSION#") || sk.startsWith("USAGE#")) {
        delete item.record?.adminAggregateVersion;
        delete item.record?.adminMetricsAggregateVersion;
        delete item.record?.usageEventHash;
      }
    }
  }

  authItems(prefix: string) {
    return this.tableItems(AUTH_TABLE).filter((item) => String(item.sk).startsWith(prefix));
  }

  tableItems(table: string) {
    return Array.from(this.items.values())
      .filter((item) => item.__table === table)
      .map(withoutTableMarker);
  }

  sessionsForUser(userId: string) {
    return this.authItems("SESSION#").filter((item) => item.record?.userId === userId);
  }

  pauseBefore(predicate: EventPredicate) {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let active = true;
    this.beforeHooks.push(async (event) => {
      if (!active || !predicate(event)) return;
      active = false;
      reached();
      await releasePromise;
    });
    return { reached: reachedPromise, release };
  }

  barrierAfter(predicate: EventPredicate, participants: number) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = true;
    this.afterHooks.push(async (event) => {
      if (!active || !predicate(event)) return;
      arrived += 1;
      if (arrived === participants) {
        active = false;
        release();
      }
      await gate;
    });
  }

  authRecord(sk: string) {
    const item = this.items.get(itemKey(AUTH_TABLE, { pk: "TENANT#prod", sk }));
    return clone(item?.record);
  }

  removeAuthGeneration(email: string) {
    for (const item of this.items.values()) {
      if (item.__table !== AUTH_TABLE) continue;
      if (item.sk === `USER#${email}` || item.record?.userEmail === email) {
        delete item.record.authGeneration;
      }
    }
  }

  async send(command: { constructor: { name: string }; input: CommandInput }) {
    const event = { name: command.constructor.name, input: command.input };
    this.commandCounts.set(event.name, (this.commandCounts.get(event.name) ?? 0) + 1);
    for (const hook of this.beforeHooks) await hook(event);
    const result = this.execute(event);
    for (const hook of this.afterHooks) await hook(event);
    return clone(result);
  }

  private execute(event: CommandEvent) {
    switch (event.name) {
      case "GetCommand":
        return { Item: clone(this.items.get(itemKey(event.input.TableName, event.input.Key))) };
      case "PutCommand":
        this.put(this.items, event.input, "ConditionalCheckFailedException");
        return {};
      case "DeleteCommand":
        this.items.delete(itemKey(event.input.TableName, event.input.Key));
        return {};
      case "UpdateCommand":
        this.update(this.items, event.input, "ConditionalCheckFailedException");
        return {};
      case "QueryCommand": {
        const pk = event.input.ExpressionAttributeValues?.[":pk"];
        const prefix = event.input.ExpressionAttributeValues?.[":prefix"];
        const startSk = event.input.ExpressionAttributeValues?.[":startSk"];
        const endSk = event.input.ExpressionAttributeValues?.[":endSk"];
        const queryKey = prefix ?? startSk ?? "";
        this.queryPages.set(queryKey, (this.queryPages.get(queryKey) ?? 0) + 1);
        if (startSk && endSk) this.usageRange = { startSk, endSk };
        const matching = Array.from(this.items.values())
          .filter((item) =>
            item.__table === event.input.TableName
            && item.pk === pk
            && (prefix !== undefined
              ? String(item.sk ?? "").startsWith(prefix)
              : String(item.sk ?? "") >= startSk && String(item.sk ?? "") <= endSk)
          )
          .sort((left, right) => String(left.sk).localeCompare(String(right.sk)));
        const exclusiveSk = event.input.ExclusiveStartKey?.sk;
        const start = exclusiveSk === undefined
          ? 0
          : Math.max(0, matching.findIndex((item) => item.sk === exclusiveSk) + 1);
        const pageSize = Math.min(this.queryPageSize, event.input.Limit ?? Number.POSITIVE_INFINITY);
        const page = matching.slice(start, start + pageSize);
        const hasMore = start + page.length < matching.length;
        const last = page[page.length - 1];
        return {
          Items: clone(page.map(withoutTableMarker)),
          ...(hasMore && last ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {})
        };
      }
      case "TransactWriteCommand":
        this.transact(event.input.TransactItems ?? []);
        return {};
      default:
        throw new Error(`Unsupported fake Dynamo command: ${event.name}`);
    }
  }

  private transact(transactItems: CommandInput[]) {
    const draft = new Map(
      Array.from(this.items.entries(), ([key, value]) => [key, clone(value)])
    );
    try {
      for (const operation of transactItems) {
        if (operation.ConditionCheck) {
          const current = draft.get(itemKey(operation.ConditionCheck.TableName, operation.ConditionCheck.Key));
          if (!conditionHolds(current, operation.ConditionCheck)) throw conditionalFailure();
        } else if (operation.Put) {
          this.put(draft, operation.Put, "TransactionCanceledException");
        } else if (operation.Update) {
          this.update(draft, operation.Update, "TransactionCanceledException");
        } else if (operation.Delete) {
          const current = draft.get(itemKey(operation.Delete.TableName, operation.Delete.Key));
          if (!conditionHolds(current, operation.Delete)) throw conditionalFailure();
          draft.delete(itemKey(operation.Delete.TableName, operation.Delete.Key));
        } else {
          throw new Error("Unsupported transaction operation in fake Dynamo client.");
        }
      }
    } catch (error) {
      const failure = error as Error;
      failure.name = "TransactionCanceledException";
      throw failure;
    }
    this.items = draft;
  }

  private put(target: Map<string, CommandInput>, input: CommandInput, failureName: string) {
    const key = itemKey(input.TableName, input.Item);
    const current = target.get(key);
    if (!conditionHolds(current, input)) throw namedError(failureName);
    target.set(key, { ...clone(input.Item), __table: input.TableName });
  }

  private update(target: Map<string, CommandInput>, input: CommandInput, failureName: string) {
    const key = itemKey(input.TableName, input.Key);
    const current = target.get(key);
    if (!conditionHolds(current, input)) throw namedError(failureName);
    if (!current) throw namedError(failureName);
    const next = clone(current);
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const record = next.record ?? (next.record = {});

    if (input.UpdateExpression?.includes("#record.#usersTotal")) {
      record[names["#usersTotal"] ?? "usersTotal"] += values[":one"];
      record[names["#version"] ?? "version"] = (record[names["#version"] ?? "version"] ?? values[":zero"])
        + values[":one"];
      record[names["#lastUserChangeAt"] ?? "lastUserChangeAt"] = values[":createdAt"];
    }

    if (":nextFailedAttempts" in values) {
      record[names["#failedAttempts"] ?? "failedAttempts"] = values[":nextFailedAttempts"];
    }
    if (":zeroFailedAttempts" in values) {
      record[names["#failedAttempts"] ?? "failedAttempts"] = values[":zeroFailedAttempts"];
    }
    if (":lockedUntil" in values) {
      record[names["#lockedUntil"] ?? "lockedUntil"] = values[":lockedUntil"];
    }
    if (":lastSeenAt" in values) {
      record[names["#lastSeenAt"] ?? "lastSeenAt"] = values[":lastSeenAt"];
    }
    if (input.UpdateExpression?.includes("REMOVE") && names["#lockedUntil"]) {
      delete record[names["#lockedUntil"]];
    }
    target.set(key, next);
  }
}

function conditionHolds(item: CommandInput | undefined, input: CommandInput) {
  const expression = String(input.ConditionExpression ?? "");
  if (!expression) return true;
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const record = item?.record ?? {};

  if (expression.includes("#record.#status <> :pending")) {
    if (!item) return true;
    return record[names["#status"] ?? "status"] !== values[":pending"]
      || record[names["#expiresAtEpoch"] ?? "expiresAtEpoch"] <= values[":nowEpoch"];
  }
  if (
    expression.includes("attribute_not_exists(#pk) OR #record.#tokenHash = :tokenHash")
  ) {
    return !item || record[names["#tokenHash"] ?? "tokenHash"] === values[":tokenHash"];
  }

  if (expression.includes("attribute_not_exists(#pk)") && item) return false;
  if (expression.includes("attribute_not_exists(#sk)") && item) return false;
  if (expression.includes("attribute_exists(#pk)") && !item) return false;
  if (expression.includes("attribute_not_exists(#record.#aggregateVersion)")) {
    const field = names["#aggregateVersion"] ?? "adminAggregateVersion";
    if (record[field] !== undefined) return false;
  }

  if (":expectedVersion" in values) {
    const field = names["#version"] ?? "version";
    if (record[field] !== values[":expectedVersion"]) return false;
  }
  if (":complete" in values) {
    const field = names["#status"] ?? "status";
    if (record[field] !== values[":complete"]) return false;
  }
  if (":metricsSchemaVersion" in values) {
    const field = names["#metricsSchemaVersion"] ?? "metricsSchemaVersion";
    if (record[field] !== values[":metricsSchemaVersion"]) return false;
  }
  if (expression.includes("attribute_exists(#record.#usersTotal)")) {
    const field = names["#usersTotal"] ?? "usersTotal";
    if (record[field] === undefined) return false;
  }
  if (":buildId" in values) {
    const field = names["#buildId"] ?? "buildId";
    if (record[field] !== values[":buildId"]) return false;
  }
  if (":expectedProvider" in values) {
    const field = names["#provider"] ?? "provider";
    if (record[field] !== values[":expectedProvider"]) return false;
  }
  if (":expectedLastSeenAt" in values) {
    const field = names["#lastSeenAt"] ?? "lastSeenAt";
    if (record[field] !== values[":expectedLastSeenAt"]) return false;
  }
  if (":expectedExpiresAt" in values) {
    const field = names["#expiresAt"] ?? "expiresAt";
    if (record[field] !== values[":expectedExpiresAt"]) return false;
  }
  if (":expectedAggregateVersion" in values) {
    const field = names["#aggregateVersion"] ?? "adminAggregateVersion";
    if (record[field] !== values[":expectedAggregateVersion"]) return false;
  }

  if (":expectedGeneration" in values) {
    const field = names["#generation"] ?? "passwordResetGeneration";
    const actual = record[field];
    const expected = values[":expectedGeneration"];
    if (actual !== expected && !(actual === undefined && expected === 0 && expression.includes("attribute_not_exists"))) {
      return false;
    }
  }
  if (":expectedAuthGeneration" in values) {
    const field = names["#authGeneration"] ?? "authGeneration";
    const actual = record[field];
    const expected = values[":expectedAuthGeneration"];
    if (actual !== expected && !(actual === undefined && expected === 0 && expression.includes("attribute_not_exists"))) {
      return false;
    }
  }
  if (":expectedFailedAttempts" in values) {
    const field = names["#failedAttempts"] ?? "failedAttempts";
    const actual = record[field] ?? 0;
    if (actual !== values[":expectedFailedAttempts"]) return false;
  }
  if (":passwordHash" in values) {
    const field = names["#passwordHash"] ?? "passwordHash";
    if (record[field] !== values[":passwordHash"]) return false;
  }
  if (":pending" in values) {
    const field = names["#status"] ?? "status";
    if (record[field] !== values[":pending"]) return false;
  }
  if (":tokenHash" in values) {
    const field = names["#tokenHash"] ?? "tokenHash";
    if (record[field] !== values[":tokenHash"]) return false;
  }
  if (expression.includes("#record.#expiresAtEpoch > :nowEpoch")) {
    const field = names["#expiresAtEpoch"] ?? "expiresAtEpoch";
    if (!(record[field] > values[":nowEpoch"])) return false;
  }
  return true;
}

function itemKey(table: string, key: CommandInput) {
  return `${table}|${String(key.pk)}|${String(key.sk ?? "")}`;
}

function withoutTableMarker(item: CommandInput) {
  const copy = clone(item);
  delete copy.__table;
  return copy;
}

function conditionalFailure() {
  return namedError("ConditionalCheckFailedException");
}

function namedError(name: string) {
  const error = new Error(name);
  error.name = name;
  return error;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
