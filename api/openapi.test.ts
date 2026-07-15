import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const source = readFileSync(resolve(process.cwd(), "api", "openapi.yaml"), "utf8");
const expressSource = readFileSync(resolve(process.cwd(), "server", "app.ts"), "utf8");
const document = parseDocument(source, {
  maxAliasCount: 0,
  strict: true,
  uniqueKeys: true
});
const api = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;

describe("OpenAPI contract invariants", () => {
  it("is strict, duplicate-free YAML with resolvable local references", () => {
    expect(document.errors.map((error) => error.message)).toEqual([]);
    expect(api.openapi).toBe("3.1.0");

    const missingReferences: string[] = [];
    walk(api, (value, location) => {
      if (!isRecord(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return;
      if (resolveJsonPointer(api, value.$ref) === undefined) {
        missingReferences.push(`${location}: ${value.$ref}`);
      }
    });
    expect(missingReferences).toEqual([]);
  });

  it("does not declare required object fields outside their owning schema", () => {
    const invalidSchemas: string[] = [];
    const schemas = objectAt(api, "components", "schemas");
    for (const [name, candidate] of Object.entries(schemas)) {
      if (!isRecord(candidate) || !Array.isArray(candidate.required)) continue;
      const properties = isRecord(candidate.properties) ? candidate.properties : {};
      const missing = candidate.required.filter(
        (property): property is string => typeof property === "string" && !(property in properties)
      );
      if (missing.length) invalidSchemas.push(`${name}: ${missing.join(", ")}`);
    }
    expect(invalidSchemas).toEqual([]);
  });

  it("keeps decision bindings and deployment credential status in separate exact schemas", () => {
    const schemas = objectAt(api, "components", "schemas");
    const decision = recordAt(schemas, "ReviewerDecision");
    const decisionProperties = recordAt(decision, "properties");
    expect(Object.keys(decisionProperties)).toEqual(expect.arrayContaining([
      "id",
      "action",
      "notes",
      "signerId",
      "signedBy",
      "signedAt",
      "createdAt",
      "memoRevision",
      "memoHash",
      "analysisId",
      "analysisHash"
    ]));

    const provider = recordAt(schemas, "OutreachProviderConfig");
    expect(provider.additionalProperties).toBe(false);
    expect(Object.keys(recordAt(provider, "properties")).sort()).toEqual([
      "credentialConfigured",
      "deploymentProvider",
      "provider",
      "ready"
    ]);
  });

  it("accepts complete valid command bodies while rejecting undeclared fields", () => {
    const hash = "a".repeat(64);
    const validBodies: Record<string, Record<string, unknown>> = {
      WorkspacePreferenceUpdateCommand: {
        expectedVersion: 2,
        selectedMemoId: "review-123",
        activeMemoBuilderSessionId: null
      },
      ReviewMemoUpdateCommand: {
        expectedVersion: 2,
        expectedRevision: 3,
        expectedHash: hash,
        memoText: "A complete memo update."
      },
      ReviewArchiveCommand: {
        expectedVersion: 2,
        expectedRevision: 3,
        expectedHash: hash,
        archived: true
      },
      ReviewDecisionCommand: {
        expectedVersion: 2,
        expectedRevision: 3,
        expectedHash: hash,
        action: "accept",
        notes: "Reviewed against the current analysis.",
        expectedAnalysisId: "analysis-123",
        expectedAnalysisHash: hash
      }
    };
    const schemas = objectAt(api, "components", "schemas");
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    for (const [schemaName, body] of Object.entries(validBodies)) {
      const validate = ajv.compile(dereferenceLocal(recordAt(schemas, schemaName), api));
      expect(validate(body), `${schemaName}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(validate({ ...body, unexpected: true })).toBe(false);
    }
  });

  it("documents the production host-only session contract and anonymous session inspection", () => {
    const servers = api.servers as Array<Record<string, unknown>>;
    expect(recordAt(recordAt(servers[0], "variables"), "tenantHost").default).toBe("app.rulix.cloud");
    expect(recordAt(recordAt(objectAt(api, "components"), "securitySchemes"), "cookieAuth").name)
      .toBe("__Host-rulix_session");
    expect(recordAt(recordAt(objectAt(api, "paths"), "/auth/me"), "get").security).toEqual([]);
  });

  it("uses unique operation IDs and requires CSRF on authenticated mutations", () => {
    const operationIds = new Map<string, string>();
    const duplicates: string[] = [];
    const missingCsrf: string[] = [];
    for (const [path, pathItem] of Object.entries(objectAt(api, "paths"))) {
      if (!isRecord(pathItem)) continue;
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const operation = pathItem[method];
        if (!isRecord(operation)) continue;
        const operationId = operation.operationId;
        if (typeof operationId !== "string" || !operationId) {
          duplicates.push(`${method.toUpperCase()} ${path}: missing operationId`);
        } else if (operationIds.has(operationId)) {
          duplicates.push(`${operationId}: ${operationIds.get(operationId)} and ${method.toUpperCase()} ${path}`);
        } else {
          operationIds.set(operationId, `${method.toUpperCase()} ${path}`);
        }

        if (!["post", "put", "patch", "delete"].includes(method)) continue;
        const security = operation.security;
        if (Array.isArray(security) && security.length === 0) continue;
        const alternatives = Array.isArray(security) ? security : [];
        const hasCookieAndCsrf = alternatives.some((alternative) => (
          isRecord(alternative) && "cookieAuth" in alternative && "csrfToken" in alternative
        ));
        if (!hasCookieAndCsrf) missingCsrf.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(duplicates).toEqual([]);
    expect(missingCsrf).toEqual([]);
  });

  it("documents every active Express API route or names a narrow retired exception", () => {
    const documented = new Set<string>();
    for (const [path, pathItem] of Object.entries(objectAt(api, "paths"))) {
      if (!isRecord(pathItem)) continue;
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (isRecord(pathItem[method])) documented.add(routeKey(method, path));
      }
    }

    const retired = new Set([
      routeKey("post", "/auth/register"),
      routeKey("get", "/account/state"),
      routeKey("put", "/account/state"),
      routeKey("post", "/ai/review")
    ]);
    const missing: string[] = [];
    const routePattern = /app\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"?]+)"/g;
    for (const match of expressSource.matchAll(routePattern)) {
      const method = match[1];
      const path = match[2].slice(4);
      const key = routeKey(method, path);
      if (path === "/health" || documented.has(key) || retired.has(key)) continue;
      missing.push(key);
    }

    expect(missing).toEqual([]);
  });
});

function walk(value: unknown, visit: (value: unknown, location: string) => void, location = "$") {
  visit(value, location);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visit, `${location}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) walk(entry, visit, `${location}.${key}`);
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  return pointer.slice(2).split("/").reduce<unknown>((current, rawSegment) => {
    if (!isRecord(current)) return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    return current[segment];
  }, root);
}

function dereferenceLocal(value: unknown, root: unknown, stack = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => dereferenceLocal(entry, root, stack));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    if (stack.has(value.$ref)) throw new Error(`Circular local OpenAPI reference: ${value.$ref}`);
    const target = resolveJsonPointer(root, value.$ref);
    if (target === undefined) throw new Error(`Missing local OpenAPI reference: ${value.$ref}`);
    const nextStack = new Set(stack).add(value.$ref);
    return dereferenceLocal(target, root, nextStack);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, dereferenceLocal(entry, root, stack)])
  );
}

function objectAt(root: unknown, ...path: string[]) {
  return path.reduce<Record<string, unknown>>((current, key) => recordAt(current, key), root as Record<string, unknown>);
}

function recordAt(root: unknown, key: string): Record<string, unknown> {
  if (!isRecord(root) || !isRecord(root[key])) throw new Error(`OpenAPI object ${key} is missing.`);
  return root[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function routeKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}")}`;
}
