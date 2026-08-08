import { createHash } from "node:crypto";
import manifestJson from "../../corpus/generated/manifest.json";
import type {
  CitationIntegrityResult,
  RegulatorySourceLocator,
  RegulatorySourceSnapshot
} from "../../src/lib/regulatoryAnalysisTypes";
import {
  generatedCclIndex,
  getApprovedCclEntry,
  validateGeneratedCclIndex,
  type CclEntry
} from "../cclIndex";

export const REQUIRED_REGULATORY_SOURCE_IDS = [
  "ear-734", "ear-738", "ear-740", "ear-742", "ear-744", "ear-746", "ear-748", "ear-762", "ear-772",
  "ear-774-supp-1", "ear-774-supp-2", "ear-774-supp-4", "itar-120", "itar-121", "ddtc-commodity-jurisdiction"
] as const;

export const REGULATORY_CORPUS_RUNTIME_VERSION = "rulix-regulatory-corpus/1";
export const CORPUS_STALE_AFTER_DAYS = 7;

interface GeneratedManifest {
  schemaVersion: "rulix.regulatory-corpus-manifest/v1";
  corpusBuildVersion: string;
  generatedAt: string;
  requestedAsOfDate: string;
  currentThrough: string;
  reviewStatus: "pending_review" | "verified" | "failed" | "superseded";
  reviewRecord: null | {
    id: string;
    reviewedAt: string;
    reviewedBy: string;
    manifestHash: string;
    affectedRulesReviewed: string[];
  };
  sources: RegulatorySourceSnapshot[];
}

const manifest = manifestJson as GeneratedManifest;

export interface RegulatoryCorpusStatus {
  available: boolean;
  structurallyValid: boolean;
  consequentialUseAllowed: boolean;
  stale: boolean;
  reviewStatus: GeneratedManifest["reviewStatus"];
  snapshotId: string;
  checksum: string;
  currentThrough: string;
  parserVersion: string;
  corpusBuildVersion: string;
  missingSourceIds: string[];
  errors: string[];
}

export function inspectRegulatoryCorpus(analysisDate = new Date().toISOString().slice(0, 10)): RegulatoryCorpusStatus {
  const validation = validateGeneratedCclIndex();
  const missingSourceIds = REQUIRED_REGULATORY_SOURCE_IDS.filter((id) =>
    !manifest.sources.some((source) => source.id === id)
  );
  const errors = [...validation.errors];
  if (manifest.schemaVersion !== "rulix.regulatory-corpus-manifest/v1") errors.push("Unsupported corpus manifest schema.");
  if (manifest.corpusBuildVersion !== generatedCclIndex.corpusBuildVersion) errors.push("The CCL index and source manifest use different build versions.");
  if (manifest.currentThrough !== generatedCclIndex.currentThrough) errors.push("The CCL index current-through date does not match the source manifest.");
  if (missingSourceIds.length) errors.push(`Required sources are missing: ${missingSourceIds.join(", ")}.`);
  if (manifest.reviewStatus === "verified") validateReviewRecord(errors);
  const stale = dateDistanceDays(manifest.currentThrough, analysisDate) > CORPUS_STALE_AFTER_DAYS;
  if (stale) errors.push(`The corpus is current through ${manifest.currentThrough}, more than ${CORPUS_STALE_AFTER_DAYS} days before the analysis date.`);
  const structurallyValid = errors.length === 0 || (errors.length === 1 && stale);
  return {
    available: true,
    structurallyValid,
    consequentialUseAllowed:
      validation.consequentialUseAllowed &&
      manifest.reviewStatus === "verified" &&
      missingSourceIds.length === 0 &&
      !stale &&
      errors.length === 0,
    stale,
    reviewStatus: manifest.reviewStatus,
    snapshotId: generatedCclIndex.snapshotId,
    checksum: generatedCclIndex.checksum,
    currentThrough: manifest.currentThrough,
    parserVersion: generatedCclIndex.parserVersion,
    corpusBuildVersion: manifest.corpusBuildVersion,
    missingSourceIds,
    errors
  };
}

export function sourceSnapshots() {
  return structuredClone(manifest.sources);
}

export function locatorForEntry(entry: CclEntry): RegulatorySourceLocator {
  return {
    sourceSnapshotId: generatedCclIndex.source.id,
    citation: generatedCclIndex.source.citation,
    title: `${entry.eccn} - ${entry.heading}`,
    part: "774",
    supplement: "1",
    eccn: entry.eccn,
    normalizedTextHash: entry.textHash
  };
}

export function exactEntryText(eccn: string, preferredSection = "List of Items Controlled") {
  const entry = getApprovedCclEntry(eccn);
  if (!entry) return undefined;
  const block = entry.blocks.find((candidate) =>
    candidate.kind === "paragraph" && candidate.text.length >= 40 && candidate.text.length <= 1800
  );
  const section = entry.sections.find((candidate) => candidate.title.toLowerCase().includes(preferredSection.toLowerCase()))
    ?? entry.sections.find((candidate) => candidate.text.length > 0);
  const text = block?.text ?? section?.text;
  if (!text) return undefined;
  const integrity = verifyExactQuotation(entry, text);
  if (integrity.quotationIntegrity !== "passed") return undefined;
  return {
    text,
    locator: {
      ...locatorForEntry(entry),
      ...(block ? { blockIndex: block.blockIndex } : { sectionTitle: section!.title }),
      normalizedTextHash: sha256(text)
    },
    integrity
  };
}

export function verifyExactQuotation(entry: CclEntry, quotation: string): CitationIntegrityResult {
  const corpus = inspectRegulatoryCorpus();
  const detail = [...corpus.errors];
  const sourceIntegrity = !corpus.structurallyValid
    ? "failed" as const
    : corpus.reviewStatus === "verified" ? "passed" as const : "pending_review" as const;
  const normalized = normalize(quotation);
  const exactBlock = entry.blocks.some((block) => normalize(block.text) === normalized && sha256(block.text) === block.textHash);
  const exactSection = entry.sections.some((section) => normalize(section.text) === normalized && sha256(section.text) === section.textHash);
  const quotationIntegrity = normalized && (exactBlock || exactSection) ? "passed" as const : "failed" as const;
  if (quotationIntegrity === "failed") detail.push("The displayed quotation is not exact stored snapshot text at the claimed structural locator.");
  return {
    sourceIntegrity,
    quotationIntegrity,
    supportIntegrity: "not_checked",
    detail
  };
}

export function verifyPointInTimeSource(sourceSnapshotId: string, analysisDate: string) {
  const source = manifest.sources.find((candidate) => candidate.id === sourceSnapshotId);
  if (!source) return { passed: false, detail: "The claimed source snapshot does not exist." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(analysisDate)) return { passed: false, detail: "The analysis date is invalid." };
  if (source.effectiveFrom && analysisDate < source.effectiveFrom) {
    return { passed: false, detail: `The source was not effective until ${source.effectiveFrom}.` };
  }
  if (source.effectiveTo && analysisDate > source.effectiveTo) {
    return { passed: false, detail: `The source was superseded after ${source.effectiveTo}.` };
  }
  if (analysisDate < source.pointInTimeDate) {
    return {
      passed: false,
      detail: `A snapshot as of ${source.pointInTimeDate} cannot prove the exact text effective on the earlier analysis date ${analysisDate}.`
    };
  }
  const currentThrough = source.currentThrough;
  if (currentThrough && analysisDate > currentThrough) {
    return {
      passed: false,
      detail: `The source is current only through ${currentThrough}, before the analysis date ${analysisDate}.`
    };
  }
  return { passed: true, detail: `The snapshot covers the analysis date ${analysisDate}.` };
}

export function verifySupportIntegrity({
  classification,
  elementResults,
  quotationIntegrity
}: {
  classification: string;
  elementResults: Array<"met" | "not_met" | "unknown" | "not_applicable">;
  quotationIntegrity: CitationIntegrityResult;
}): CitationIntegrityResult {
  const detail = [...quotationIntegrity.detail];
  const exactRecommendation = classification !== "NOT_ESTABLISHED" && classification !== "EAR99";
  const supported = !exactRecommendation || (
    quotationIntegrity.sourceIntegrity === "passed" &&
    quotationIntegrity.quotationIntegrity === "passed" &&
    elementResults.length > 0 &&
    elementResults.every((result) => result === "met" || result === "not_applicable")
  );
  if (!supported) detail.push("The proposition is not supported by exact source text plus completed validated elements.");
  return {
    ...quotationIntegrity,
    supportIntegrity: supported ? "passed" : "failed",
    detail
  };
}

function validateReviewRecord(errors: string[]) {
  if (!manifest.reviewRecord) {
    errors.push("The corpus claims verified status without a review record.");
    return;
  }
  const base = { ...manifest, reviewStatus: "pending_review", reviewRecord: null };
  const expectedHash = sha256(stableJson(base));
  if (manifest.reviewRecord.manifestHash !== expectedHash) errors.push("The corpus review record is not bound to this exact manifest.");
  if (!manifest.reviewRecord.reviewedBy.trim() || !manifest.reviewRecord.reviewedAt) errors.push("The corpus review record is incomplete.");
}

function dateDistanceDays(left: string, right: string) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((rightTime - leftTime) / 86_400_000));
}

function normalize(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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
