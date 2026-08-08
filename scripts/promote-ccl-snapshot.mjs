import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const candidatePath = path.resolve("corpus", "generated", "ccl-index.json");
const candidateManifestPath = path.resolve("corpus", "generated", "manifest.json");
const reviewedDirectory = path.resolve("corpus", "reviewed");
const serverIndexPath = path.resolve("server", "data", "ccl-index.generated.json");
const frontendMetadataPath = path.resolve("src", "data", "ccl-metadata.generated.json");
const recordArgument = process.argv.find((argument) => argument.startsWith("--review-record="));

if (!recordArgument) {
  throw new Error(
    "Usage: npm run promote:corpus-index -- --review-record=corpus/reviews/<review>.json. Environment variables are not review evidence."
  );
}

const reviewRecordPath = path.resolve(recordArgument.slice("--review-record=".length));
const [candidate, manifest, reviewRecord] = await Promise.all([
  readJson(candidatePath),
  readJson(candidateManifestPath),
  readJson(reviewRecordPath)
]);

validateCandidate(candidate, manifest);
validateReviewRecord(reviewRecord, candidate, manifest);
await validateRawSources(manifest);

const reviewBinding = {
  id: reviewRecord.id,
  reviewedAt: reviewRecord.reviewedAt,
  reviewer: reviewRecord.reviewer,
  sourceManifestHash: reviewRecord.sourceManifestHash,
  candidateChecksum: reviewRecord.candidateChecksum,
  changedSourceIds: reviewRecord.changedSourceIds,
  affectedRuleIds: reviewRecord.affectedRuleIds,
  parserRegression: reviewRecord.parserRegression,
  executableRuleValidationRecordIds: reviewRecord.executableRuleValidationRecordIds,
  attestation: reviewRecord.attestation
};
const reviewedManifest = {
  ...manifest,
  reviewStatus: "verified",
  reviewRecord: reviewBinding,
  sources: manifest.sources.map((source) => ({ ...source, verificationStatus: "verified" }))
};
const { checksum: _candidateChecksum, ...candidateWithoutChecksum } = candidate;
const reviewedIndexBase = {
  ...candidateWithoutChecksum,
  reviewStatus: "verified",
  reviewRecord: reviewBinding,
  source: { ...candidate.source, verificationStatus: "verified" }
};
const reviewedIndex = {
  ...reviewedIndexBase,
  checksum: sha256(stableJson(reviewedIndexBase))
};

await mkdir(reviewedDirectory, { recursive: true });
const reviewedIndexPath = path.join(reviewedDirectory, `${candidate.snapshotId}.json`);
const reviewedManifestPath = path.join(reviewedDirectory, `${candidate.snapshotId}.manifest.json`);
const reviewedMetadata = {
  schemaVersion: reviewedIndex.schemaVersion,
  snapshotId: reviewedIndex.snapshotId,
  checksum: reviewedIndex.checksum,
  pointInTimeDate: reviewedIndex.pointInTimeDate,
  effectiveAt: reviewedIndex.effectiveAt,
  currentThrough: reviewedIndex.currentThrough,
  entryCount: reviewedIndex.entryCount,
  reviewStatus: reviewedIndex.reviewStatus
};
await Promise.all([
  writeFile(reviewedIndexPath, `${JSON.stringify(reviewedIndex)}\n`, "utf8"),
  writeFile(reviewedManifestPath, `${JSON.stringify(reviewedManifest, null, 2)}\n`, "utf8"),
  writeFile(serverIndexPath, `${JSON.stringify(reviewedIndex)}\n`, "utf8"),
  writeFile(frontendMetadataPath, `${JSON.stringify(reviewedMetadata, null, 2)}\n`, "utf8")
]);

console.log(`Prepared reviewed corpus artifacts for ${candidate.snapshotId}.`);
console.log("Updated the server snapshot for activation only when this reviewed change merges. Parser-generated rules remain non-executable unless named in independent expert validation records.");

function validateCandidate(index, sourceManifest) {
  if (index.schemaVersion !== "rulix.ccl-index/v3" || index.reviewStatus !== "pending_review") {
    throw new Error("Only a complete pending-review v3 CCL candidate can enter review.");
  }
  if (sourceManifest.schemaVersion !== "rulix.regulatory-corpus-manifest/v1" || sourceManifest.reviewStatus !== "pending_review") {
    throw new Error("The source manifest must be a pending-review v1 manifest.");
  }
  const { checksum, ...base } = index;
  if (!checksum || sha256(stableJson(base)) !== checksum) {
    throw new Error("The candidate index checksum is invalid.");
  }
  if (!Array.isArray(sourceManifest.sources) || sourceManifest.sources.length === 0) {
    throw new Error("The source manifest contains no sources.");
  }
}

function validateReviewRecord(record, index, sourceManifest) {
  if (record.schemaVersion !== "rulix.corpus-review/v1") throw new Error("Unsupported corpus review record schema.");
  requiredString(record.id, "review record id");
  if (record.snapshotId !== index.snapshotId) throw new Error("The review record snapshotId does not match the candidate.");
  if (record.candidateChecksum !== index.checksum) throw new Error("The review record candidateChecksum does not match the candidate.");
  const expectedManifestHash = sha256(stableJson(sourceManifest));
  if (record.sourceManifestHash !== expectedManifestHash) throw new Error("The review record sourceManifestHash does not match the exact manifest.");
  if (!Number.isFinite(Date.parse(record.reviewedAt))) throw new Error("The review record reviewedAt timestamp is invalid.");
  requiredString(record.reviewer?.name, "reviewer name");
  requiredString(record.reviewer?.organization, "reviewer organization");
  requiredString(record.reviewer?.qualification, "reviewer qualification");
  if (record.attestation !== "I compared the identified source text and parser output, recorded every material discrepancy, and accept responsibility for this corpus review.") {
    throw new Error("The qualified-reviewer attestation is missing or altered.");
  }
  const sourceIds = new Set(sourceManifest.sources.map((source) => source.id));
  const changedSourceIds = requiredStringArray(record.changedSourceIds, "changedSourceIds");
  if (changedSourceIds.some((id) => !sourceIds.has(id))) throw new Error("The review record names a source outside the manifest.");
  requiredStringArray(record.affectedRuleIds, "affectedRuleIds", { allowEmpty: true });
  requiredStringArray(record.executableRuleValidationRecordIds, "executableRuleValidationRecordIds", { allowEmpty: true });
  if (record.parserRegression?.passed !== true) throw new Error("Parser regression evidence must record a passing run.");
  requiredString(record.parserRegression?.command, "parser regression command");
  if (!/^[a-f0-9]{64}$/.test(record.parserRegression?.outputHash ?? "")) {
    throw new Error("Parser regression outputHash must be a SHA-256 digest of preserved test output.");
  }
}

async function validateRawSources(manifest) {
  for (const source of manifest.sources) {
    if (!/^[a-f0-9]{64}$/.test(source.rawByteHash ?? "")) throw new Error(`Source ${source.id} has no valid raw-byte hash.`);
    const rawPath = path.resolve("corpus", "raw", source.rawFile);
    const relative = path.relative(path.resolve("corpus", "raw"), rawPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Source ${source.id} escapes the raw corpus directory.`);
    const bytes = await readFile(rawPath);
    if (sha256(bytes) !== source.rawByteHash) throw new Error(`Raw source integrity failed for ${source.id}.`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length < 2) throw new Error(`Missing ${label}.`);
  return value.trim();
}

function requiredStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be ${options.allowEmpty ? "an" : "a non-empty"} array of strings.`);
  }
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
