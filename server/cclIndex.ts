import { createHash } from "node:crypto";
import generatedIndex from "./data/ccl-index.generated.json";

export interface CclSection {
  title: string;
  text: string;
  startBlockIndex: number;
  textHash: string;
}

export interface CclBlock {
  blockIndex: number;
  tag: string;
  kind: "note" | "section_heading" | "cross_reference" | "paragraph" | "text";
  paragraphLabel?: string;
  text: string;
  textHash: string;
  locator: string;
}

export interface CclEntry {
  eccn: string;
  category: number;
  productGroup: string;
  heading: string;
  controls: string;
  exceptions: string;
  items: string;
  notes: Array<{ locator: string; text: string; textHash: string }>;
  definitions: string[];
  crossReferences: string[];
  sections: CclSection[];
  blocks: CclBlock[];
  fullText: string;
  textHash: string;
  locator: string;
  validationStatus: "parser_generated_unreviewed" | "expert_validated";
}

export interface CclIndexSnapshot {
  schemaVersion: "rulix.ccl-index/v3";
  snapshotId: string;
  checksum: string;
  pointInTimeDate: string;
  effectiveAt?: string;
  currentThrough: string;
  retrievedAt: string;
  parserVersion: string;
  corpusBuildVersion: string;
  reviewStatus: "pending_review" | "verified" | "failed" | "superseded";
  reviewRecord?: {
    id: string;
    reviewedAt: string;
    reviewer: {
      name: string;
      organization: string;
      qualification: string;
    };
    sourceManifestHash: string;
    candidateChecksum: string;
    changedSourceIds: string[];
    affectedRuleIds: string[];
    parserRegression: {
      command: string;
      passed: true;
      outputHash: string;
    };
    executableRuleValidationRecordIds: string[];
    attestation: string;
  };
  requiredSourceIds: string[];
  entryCount: number;
  source: {
    id: string;
    title: string;
    citation: string;
    url: string;
    apiUrl: string;
    rawByteHash: string;
    byteLength: number;
    rawFile: string;
    verificationStatus: "pending_review" | "verified" | "failed" | "superseded";
  };
  entries: CclEntry[];
}

export interface CclSearchHit {
  entry: CclEntry;
  score: number;
  matchedTerms: string[];
}

/**
 * Parser output is deliberately pending until a qualified reviewer validates
 * the affected rules. Importing it supports retrieval and review; it does not
 * authorize a consequential classification.
 */
export const generatedCclIndex = generatedIndex as CclIndexSnapshot;
/** @deprecated Compatibility alias. Callers must inspect reviewStatus and the
 * corpus gate before relying on this snapshot for a consequential decision. */
export const approvedCclIndex = generatedCclIndex;

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "been", "being", "controlled", "for", "from", "have",
  "into", "item", "items", "more", "not", "only", "other", "such", "than", "that", "the", "their",
  "these", "this", "those", "under", "use", "used", "using", "with"
]);

export function searchApprovedCcl(query: string, limit = 12): CclSearchHit[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  return approvedCclIndex.entries
    .map((entry) => rankEntry(entry, terms))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.eccn.localeCompare(right.entry.eccn))
    .slice(0, Math.max(1, Math.min(limit, 30)));
}

export function getApprovedCclEntry(eccn: string): CclEntry | undefined {
  const normalized = eccn.trim().toUpperCase();
  return approvedCclIndex.entries.find((entry) => entry.eccn === normalized);
}

let defaultValidation: ReturnType<typeof validateIndex> | undefined;

export function validateGeneratedCclIndex(index: CclIndexSnapshot = generatedCclIndex) {
  if (index === generatedCclIndex && defaultValidation) return defaultValidation;
  const result = validateIndex(index);
  if (index === generatedCclIndex) defaultValidation = result;
  return result;
}

function validateIndex(index: CclIndexSnapshot) {
  const errors: string[] = [];
  if (index.schemaVersion !== "rulix.ccl-index/v3") errors.push("Unsupported CCL index schema.");
  if (index.entryCount < 600 || index.entries.length !== index.entryCount) errors.push("The CCL index is incomplete.");
  if (new Set(index.entries.map((entry) => entry.eccn)).size !== index.entries.length) errors.push("The CCL index contains duplicate identifiers.");
  if (!/^[a-f0-9]{64}$/.test(index.source.rawByteHash)) errors.push("The CCL source hash is invalid.");
  for (const entry of index.entries) {
    if (sha256(entry.fullText) !== entry.textHash) errors.push(`Entry ${entry.eccn} text hash changed.`);
    if (entry.blocks.some((block) => sha256(block.text) !== block.textHash)) errors.push(`Entry ${entry.eccn} block hash changed.`);
  }
  const { checksum: _checksum, ...base } = index;
  if (sha256(stableJson(base)) !== index.checksum) errors.push("The generated CCL index checksum changed.");
  return {
    valid: errors.length === 0,
    errors,
    consequentialUseAllowed: errors.length === 0 && index.reviewStatus === "verified" && index.source.verificationStatus === "verified"
  };
}

function rankEntry(entry: CclEntry, terms: string[]): CclSearchHit {
  const heading = entry.heading.toLowerCase();
  const fullText = entry.fullText.toLowerCase();
  const eccn = entry.eccn.toLowerCase();
  const matchedTerms: string[] = [];
  let score = 0;
  for (const term of terms) {
    if (!fullText.includes(term) && !eccn.includes(term)) continue;
    matchedTerms.push(term);
    if (eccn === term) score += 100;
    else if (eccn.startsWith(term)) score += 30;
    else if (heading.includes(term)) score += 8;
    else score += 2;
  }
  return { entry, score, matchedTerms };
}

function tokenize(value: string) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9.-]{2,}/g) ?? [])]
    .filter((term) => !SEARCH_STOP_WORDS.has(term))
    .slice(0, 80);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
