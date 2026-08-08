import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifestJson from "../corpus/generated/manifest.json";
import type { AgentToolName, CaseEvidence, MemoRecord } from "../src/types";
import { generatedCclIndex, getApprovedCclEntry, searchApprovedCcl, type CclEntry } from "./cclIndex";
import { inspectRegulatoryCorpus } from "./regulatory/corpus";

export interface RegulatoryToolRecord {
  id: string;
  sourceId: string;
  title: string;
  locator: string;
  sourceDate: string;
  contentHash: string;
  text: string;
  url: string;
  approvalStatus: "approved" | "pending" | "superseded" | "failed";
  supersedesSourceId?: string;
}

export interface AgentRegulatoryCorpus {
  status(): ReturnType<typeof inspectRegulatoryCorpus>;
  search(query: string, limit?: number): RegulatoryToolRecord[];
  read(sourceId: string, start?: number, length?: number): RegulatoryToolRecord | undefined;
  followCrossReferences(sourceId: string): RegulatoryToolRecord[];
}

export interface AgentToolExecution {
  callId: string;
  name: AgentToolName;
  result: unknown;
  resultHash: string;
}

export const AGENT_TOOL_NAMES: AgentToolName[] = [
  "search_regulatory_corpus",
  "read_regulatory_source",
  "follow_regulatory_cross_reference",
  "search_case_documents",
  "read_case_excerpt",
  "list_case_evidence",
  "read_agent_artifact"
];

export class GeneratedRegulatoryCorpus implements AgentRegulatoryCorpus {
  private readonly rawSources = new Map<string, { metadata: ManifestSource; text: string }>();

  status() {
    return inspectRegulatoryCorpus();
  }

  search(query: string, limit = 12) {
    const bounded = Math.max(1, Math.min(limit, 30));
    const entryResults = searchApprovedCcl(query, bounded).map(({ entry }) => cclRecord(entry));
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return entryResults;
    const sourceResults: RegulatoryToolRecord[] = [];
    for (const source of manifest.sources) {
      const loaded = this.loadRawSource(source);
      const offset = loaded.text.toLocaleLowerCase().indexOf(normalizedQuery);
      if (offset < 0) continue;
      sourceResults.push(rawRecord(source, loaded.text, Math.max(0, offset - 600), 2400));
      if (sourceResults.length >= bounded) break;
    }
    return uniqueRecords([...entryResults, ...sourceResults]).slice(0, bounded);
  }

  read(sourceId: string, start = 0, length = 16000) {
    if (sourceId.startsWith("ccl:")) {
      const entry = getApprovedCclEntry(sourceId.slice(4));
      return entry ? cclRecord(entry) : undefined;
    }
    const normalizedId = sourceId.startsWith("source:") ? sourceId.slice(7).split(":")[0] : sourceId;
    const source = manifest.sources.find((item) => item.id === normalizedId);
    if (!source) return undefined;
    const loaded = this.loadRawSource(source);
    return rawRecord(source, loaded.text, start, length);
  }

  followCrossReferences(sourceId: string) {
    if (!sourceId.startsWith("ccl:")) return [];
    const entry = getApprovedCclEntry(sourceId.slice(4));
    if (!entry) return [];
    const referenced = new Set(
      entry.crossReferences.flatMap((value) => value.toUpperCase().match(/\b[0-9][A-E][0-9]{3}\b/g) ?? [])
    );
    return [...referenced].flatMap((eccn) => {
      const target = getApprovedCclEntry(eccn);
      return target ? [cclRecord(target)] : [];
    });
  }

  private loadRawSource(source: ManifestSource) {
    const cached = this.rawSources.get(source.id);
    if (cached) return cached;
    const corpusRoot = resolveCorpusRoot();
    const rawPath = join(corpusRoot, "raw", source.rawFile);
    if (!existsSync(rawPath)) throw new Error(`Authoritative corpus bytes are unavailable for ${source.id}.`);
    const bytes = readFileSync(rawPath);
    if (sha256(bytes) !== source.rawByteHash) throw new Error(`Authoritative corpus bytes changed for ${source.id}.`);
    const text = extractReadableText(bytes.toString("utf8"));
    const loaded = { metadata: source, text };
    this.rawSources.set(source.id, loaded);
    return loaded;
  }
}

export class AgentToolRuntime {
  private readonly excerptRecords = new Map<string, { text: string; start: number; end: number }>();
  private readonly sourceRecords = new Map<string, RegulatoryToolRecord>();

  constructor(private readonly input: {
    accountId: string;
    memo: MemoRecord;
    allowedTools: ReadonlySet<AgentToolName>;
    corpus: AgentRegulatoryCorpus;
    caseEvidence?: CaseEvidence;
    artifacts?: ReadonlyMap<string, unknown>;
    scopedSourceIds?: ReadonlySet<string>;
  }) {
    for (const sourceId of input.scopedSourceIds ?? []) {
      const record = input.corpus.read(sourceId);
      if (record) this.rememberSources([record]);
    }
  }

  definitions() {
    return [...this.input.allowedTools].map((name) => toolDefinition(name));
  }

  execute(callId: string, name: string, rawInput: unknown): AgentToolExecution {
    if (!isToolName(name) || !this.input.allowedTools.has(name)) throw new Error(`Tool ${name} is not permitted for this agent.`);
    const args = record(rawInput);
    let result: unknown;
    if (name === "search_regulatory_corpus") {
      const query = boundedString(args.query, 1, 1000);
      const records = this.input.corpus.search(query, boundedInteger(args.limit, 1, 30, 12));
      result = records.filter((item) => !this.input.scopedSourceIds || this.input.scopedSourceIds.has(item.sourceId));
      this.rememberSources(result as RegulatoryToolRecord[]);
    } else if (name === "read_regulatory_source") {
      const sourceId = boundedString(args.sourceId, 1, 300);
      if (this.input.scopedSourceIds && !this.input.scopedSourceIds.has(sourceId)) throw new Error("The requested source is outside this candidate agent's scope.");
      const item = this.input.corpus.read(sourceId, boundedInteger(args.start, 0, 10_000_000, 0), boundedInteger(args.length, 1, 30000, 16000));
      if (!item) throw new Error("Regulatory source not found.");
      this.rememberSources([item]);
      result = item;
    } else if (name === "follow_regulatory_cross_reference") {
      const sourceId = boundedString(args.sourceId, 1, 300);
      if (this.input.scopedSourceIds && !this.input.scopedSourceIds.has(sourceId)) throw new Error("The requested source is outside this candidate agent's scope.");
      const records = this.input.corpus.followCrossReferences(sourceId)
        .filter((item) => !this.input.scopedSourceIds || this.input.scopedSourceIds.has(item.sourceId));
      this.rememberSources(records);
      result = records;
    } else if (name === "search_case_documents") {
      const query = boundedString(args.query, 1, 800);
      result = this.searchMemo(query, boundedInteger(args.limit, 1, 30, 12));
    } else if (name === "read_case_excerpt") {
      const excerptId = boundedString(args.excerptId, 1, 240);
      const excerpt = this.excerptRecords.get(excerptId);
      if (!excerpt) throw new Error("Case excerpt not found in this case scope.");
      result = { id: excerptId, documentId: `memo:${this.input.memo.id}`, location: `characters ${excerpt.start}-${excerpt.end}`, contentHash: sha256(excerpt.text), exactText: excerpt.text };
    } else if (name === "list_case_evidence") {
      if (!this.input.caseEvidence) throw new Error("The evidence ledger is not available at this stage.");
      result = this.input.caseEvidence;
    } else {
      const artifactId = boundedString(args.artifactId, 1, 300);
      const artifact = this.input.artifacts?.get(artifactId);
      if (artifact === undefined) throw new Error("Agent artifact not found in this workflow scope.");
      result = { artifactId, contentHash: sha256(stableJson(artifact)), content: artifact };
    }
    return { callId, name, result, resultHash: sha256(stableJson(result)) };
  }

  allowedSourceIds() {
    return new Set([...this.sourceRecords.values()].map((record) => record.sourceId));
  }

  sourceRecord(sourceId: string) {
    return [...this.sourceRecords.values()].find((record) => record.sourceId === sourceId);
  }

  regulatoryCitations() {
    return [...this.sourceRecords.values()].map((record) => ({
      sourceId: record.sourceId,
      locator: record.locator,
      sourceDate: record.sourceDate,
      contentHash: record.contentHash,
      exactText: record.text
    }));
  }

  private rememberSources(records: RegulatoryToolRecord[]) {
    for (const item of records) this.sourceRecords.set(`${item.sourceId}:${item.locator}:${item.contentHash}`, item);
  }

  private searchMemo(query: string, limit: number) {
    const text = this.input.memo.memoText;
    const normalized = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const results: Array<{ id: string; documentId: string; location: string; contentHash: string; exactText: string }> = [];
    let cursor = 0;
    while (results.length < limit) {
      const found = normalized.indexOf(needle, cursor);
      if (found < 0) break;
      const start = Math.max(0, found - 400);
      const end = Math.min(text.length, found + needle.length + 400);
      const excerptText = text.slice(start, end);
      const id = `case:${this.input.memo.id}:${start}:${end}:${sha256(excerptText).slice(0, 12)}`;
      this.excerptRecords.set(id, { text: excerptText, start, end });
      results.push({ id, documentId: `memo:${this.input.memo.id}`, location: `characters ${start}-${end}`, contentHash: sha256(excerptText), exactText: excerptText });
      cursor = found + Math.max(1, needle.length);
    }
    return results;
  }
}

const manifest = manifestJson as { sources: ManifestSource[] };
interface ManifestSource {
  id: string;
  title: string;
  citation: string;
  canonicalUrl: string;
  rawFile: string;
  rawByteHash: string;
  pointInTimeDate: string;
  currentThrough?: string;
  verificationStatus: "pending_review" | "verified" | "failed" | "superseded";
  supersedesSnapshotId?: string;
}

function cclRecord(entry: CclEntry): RegulatoryToolRecord {
  return {
    id: `ccl:${entry.eccn}`,
    sourceId: `ccl:${entry.eccn}`,
    title: `${entry.eccn} - ${entry.heading}`,
    locator: entry.locator,
    sourceDate: generatedCclIndex.currentThrough,
    contentHash: entry.textHash,
    text: entry.fullText,
    url: generatedCclIndex.source.url,
    approvalStatus: generatedCclIndex.reviewStatus === "verified" ? "approved" : generatedCclIndex.reviewStatus === "superseded" ? "superseded" : generatedCclIndex.reviewStatus === "failed" ? "failed" : "pending"
  };
}

function rawRecord(source: ManifestSource, fullText: string, requestedStart: number, requestedLength: number): RegulatoryToolRecord {
  const start = Math.max(0, Math.min(requestedStart, fullText.length));
  const length = Math.max(1, Math.min(requestedLength, 30000));
  const text = fullText.slice(start, start + length);
  return {
    id: `source:${source.id}:${start}:${sha256(text).slice(0, 12)}`,
    sourceId: `source:${source.id}`,
    title: source.title,
    locator: `${source.citation}, normalized characters ${start}-${start + text.length}`,
    sourceDate: source.currentThrough ?? source.pointInTimeDate,
    contentHash: sha256(text),
    text,
    url: source.canonicalUrl,
    approvalStatus: source.verificationStatus === "verified" ? "approved" : source.verificationStatus === "superseded" ? "superseded" : source.verificationStatus === "failed" ? "failed" : "pending",
    ...(source.supersedesSnapshotId ? { supersedesSourceId: source.supersedesSnapshotId } : {})
  };
}

function toolDefinition(name: AgentToolName) {
  const common = { name, description: `Read-only ${name} tool. Results are limited to the approved tenant, case, and corpus snapshot.` };
  if (name === "search_regulatory_corpus") return { ...common, input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 1000 }, limit: { type: "integer", minimum: 1, maximum: 30 } } } };
  if (name === "read_regulatory_source") return { ...common, input_schema: { type: "object", additionalProperties: false, required: ["sourceId"], properties: { sourceId: { type: "string", minLength: 1, maxLength: 300 }, start: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 30000 } } } };
  if (name === "follow_regulatory_cross_reference") return { ...common, input_schema: { type: "object", additionalProperties: false, required: ["sourceId"], properties: { sourceId: { type: "string", minLength: 1, maxLength: 300 } } } };
  if (name === "search_case_documents") return { ...common, input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 800 }, limit: { type: "integer", minimum: 1, maximum: 30 } } } };
  if (name === "read_case_excerpt") return { ...common, input_schema: { type: "object", additionalProperties: false, required: ["excerptId"], properties: { excerptId: { type: "string", minLength: 1, maxLength: 240 } } } };
  if (name === "read_agent_artifact") return { ...common, input_schema: { type: "object", additionalProperties: false, required: ["artifactId"], properties: { artifactId: { type: "string", minLength: 1, maxLength: 300 } } } };
  return { ...common, input_schema: { type: "object", additionalProperties: false, properties: {} } };
}

function resolveCorpusRoot() {
  const configured = process.env.RULIX_CORPUS_DIR?.trim();
  const candidates = [configured, join(process.cwd(), "corpus"), join(process.cwd(), "..", "corpus")].filter((item): item is string => Boolean(item));
  const found = candidates.find((item) => existsSync(join(item, "raw")));
  if (!found) throw new Error("Authoritative corpus directory is unavailable.");
  return found;
}

function extractReadableText(markup: string) {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isToolName(value: string): value is AgentToolName {
  return AGENT_TOOL_NAMES.includes(value as AgentToolName);
}

function boundedString(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string" || value.trim().length < minimum || value.trim().length > maximum) throw new Error("Tool input string is invalid.");
  return value.trim();
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Tool input number is invalid.");
  return value;
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object.");
  return value as Record<string, unknown>;
}

function uniqueRecords(values: RegulatoryToolRecord[]) {
  const seen = new Set<string>();
  return values.filter((value) => !seen.has(value.sourceId) && Boolean(seen.add(value.sourceId)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).filter((key) => item[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
