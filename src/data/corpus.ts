import manifestJson from "../../corpus/generated/manifest.json";
import metadataJson from "./ccl-metadata.generated.json";
import type { CorpusSnapshot, SourceDocument } from "../types";

interface BrowserCorpusManifest {
  generatedAt: string;
  currentThrough: string;
  reviewStatus: "pending_review" | "verified" | "failed" | "superseded";
  sources: Array<{
    id: string;
    jurisdiction: string;
    title: string;
    canonicalUrl: string;
    pointInTimeDate: string;
    retrievedAt: string;
    effectiveFrom?: string;
    rawByteHash: string;
    parserVersion: string;
    verificationStatus: "pending_review" | "verified" | "failed" | "superseded";
  }>;
}

const manifest = manifestJson as BrowserCorpusManifest;
const metadata = metadataJson as {
  snapshotId: string;
  checksum: string;
  pointInTimeDate: string;
  currentThrough: string;
  entryCount: number;
  reviewStatus: "pending_review" | "verified" | "failed" | "superseded";
};

/**
 * Browser-safe metadata for the authoritative server corpus. Exact source text
 * stays in the hashed server snapshots and is exposed only through scoped,
 * read-only agent tools. No legal paraphrases or classification hints are
 * shipped as browser seed chunks.
 */
export const officialCorpus: CorpusSnapshot = {
  id: metadata.snapshotId,
  label: `Authoritative regulatory corpus through ${metadata.currentThrough} (${metadata.entryCount} CCL entries)`,
  generatedAt: manifest.generatedAt,
  checksum: metadata.checksum,
  schemaVersion: 3,
  sourceKind: "verified-primary",
  approvalStatus: metadata.reviewStatus === "verified" ? "approved" : "pending",
  documents: manifest.sources.map((source): SourceDocument => ({
    id: source.id,
    title: source.title,
    authority: source.jurisdiction === "ITAR" ? "ITAR" : "EAR",
    url: source.canonicalUrl,
    snapshotDate: source.pointInTimeDate,
    retrievedAt: source.retrievedAt,
    effectiveAt: source.effectiveFrom,
    contentHash: source.rawByteHash,
    parserVersion: source.parserVersion,
    approvalStatus: source.verificationStatus === "verified" ? "approved" : "pending"
  })),
  chunks: []
};

export const getSourceChunk = (id: string) =>
  officialCorpus.chunks.find((chunk) => chunk.id === id);
