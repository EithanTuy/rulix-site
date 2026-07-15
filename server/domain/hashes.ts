import { createHash } from "node:crypto";
import type { AuditEvent, MemoRecord, ReviewResult } from "../../src/types";

type MemoContent = Pick<
  MemoRecord,
  | "title"
  | "itemFamily"
  | "memoText"
  | "attachments"
  | "dataClass"
  | "sourcePath"
  | "manufacturer"
  | "intendedUse"
>;

/**
 * Produces a deterministic JSON representation suitable for integrity hashes.
 * Object keys are sorted, object properties with `undefined` are omitted, and
 * array holes/undefined values match JSON's `null` behavior.
 */
export function canonicalJson(value: unknown): string {
  const normalized = canonicalize(value, new WeakSet<object>(), false);
  if (normalized === undefined) {
    throw new TypeError("Canonical JSON requires a JSON value at the root.");
  }
  return JSON.stringify(normalized);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Hashes only the fields that define a memo revision's reviewable content. */
export function hashMemoContent(memo: MemoContent): string {
  return sha256Canonical({
    title: memo.title,
    itemFamily: memo.itemFamily,
    memoText: memo.memoText,
    attachments: memo.attachments,
    dataClass: memo.dataClass,
    sourcePath: memo.sourcePath,
    manufacturer: memo.manufacturer,
    intendedUse: memo.intendedUse
  });
}

/** Excludes the stored digest so recalculating an already-hashed result is stable. */
export function hashReviewResult(result: ReviewResult): string {
  const { resultHash: _storedHash, ...hashable } = result as ReviewResult & {
    resultHash?: string;
  };
  return sha256Canonical(hashable);
}

/** Includes the previous event hash but excludes this event's stored digest. */
export function hashAuditEvent(event: AuditEvent): string {
  const { eventHash: _storedHash, ...hashable } = event as AuditEvent & {
    eventHash?: string;
  };
  return sha256Canonical(hashable);
}

function canonicalize(value: unknown, ancestors: WeakSet<object>, inArray: boolean): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON cannot hash non-finite numbers.");
      }
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
    case "function":
    case "symbol":
      return inArray ? null : undefined;
    case "bigint":
      throw new TypeError("Canonical JSON cannot hash bigint values.");
    case "object":
      break;
    default:
      throw new TypeError(`Canonical JSON cannot hash values of type ${typeof value}.`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError("Canonical JSON cannot hash cyclic values.");
  }
  ancestors.add(objectValue);

  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new TypeError("Canonical JSON cannot hash an invalid Date.");
      }
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors, true));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON can only hash plain objects, arrays, and Dates.");
    }

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = canonicalize(
        (value as Record<string, unknown>)[key],
        ancestors,
        false
      );
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  } finally {
    ancestors.delete(objectValue);
  }
}
