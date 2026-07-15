import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { DEFAULT_BEDROCK_MODEL, getBedrockRuntime, type UsageSample } from "./bedrockCouncil";
import {
  AiEgressPolicyError,
  dispatchAuthorizedAiRequest,
  resolveBedrockLane,
  type AiEgressContext,
  type AiProviderClient,
  type AiProviderLane
} from "./aiEgressGateway";

export interface DocumentExtractionInput {
  fileName: string;
  mediaType: string;
  dataBase64: string;
}

export interface DocumentExtractionResult {
  fileName: string;
  mediaType: string;
  text: string;
  method: "text" | "bedrock-document" | "bedrock-image" | "pdf-image-fallback" | "unavailable";
  warning?: string;
}

interface DocumentExtractionOptions {
  onUsage?: (sample: UsageSample) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  providerClient?: AiProviderClient;
  egress?: Pick<
    AiEgressContext,
    "accountId" | "approvalId" | "dataClass" | "dispatchId" | "subject"
  >;
}

interface DocumentExtractionDispatchOptions extends DocumentExtractionOptions {
  signal: AbortSignal;
}

const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;
const MAX_DATA_URL_HEADER_CHARS = 1_024;
const MAX_DATA_URL_PARAMETERS = 16;
const MEANINGFUL_TEXT_CHARS = 80;
const MEANINGFUL_WORDS = 12;
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
interface FilePolicy {
  mediaType: string;
  acceptedMediaTypes: readonly string[];
}

const FILE_POLICIES: Record<string, FilePolicy> = {
  ".txt": { mediaType: "text/plain", acceptedMediaTypes: ["text/plain"] },
  ".md": { mediaType: "text/markdown", acceptedMediaTypes: ["text/markdown", "text/plain"] },
  ".csv": { mediaType: "text/csv", acceptedMediaTypes: ["text/csv", "text/plain", "application/vnd.ms-excel"] },
  ".json": { mediaType: "application/json", acceptedMediaTypes: ["application/json", "text/json", "text/plain"] },
  ".pdf": { mediaType: "application/pdf", acceptedMediaTypes: ["application/pdf"] },
  ".docx": { mediaType: DOCX_MEDIA_TYPE, acceptedMediaTypes: [DOCX_MEDIA_TYPE] },
  ".png": { mediaType: "image/png", acceptedMediaTypes: ["image/png"] },
  ".jpg": { mediaType: "image/jpeg", acceptedMediaTypes: ["image/jpeg"] },
  ".jpeg": { mediaType: "image/jpeg", acceptedMediaTypes: ["image/jpeg"] },
  ".webp": { mediaType: "image/webp", acceptedMediaTypes: ["image/webp"] }
};
type DocumentValidationCode =
  | "invalid_base64"
  | "invalid_docx_container"
  | "document_expansion_limit"
  | "unsupported_file_type"
  | "media_type_mismatch"
  | "file_signature_mismatch";

export class DocumentValidationError extends Error {
  readonly status = 400;

  constructor(readonly code: DocumentValidationCode, message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

export type PreparedDocumentExtractionInput =
  | {
      tooLarge: true;
      fileName: string;
      mediaType: string;
      requiresAi: false;
    }
  | {
      tooLarge: false;
      input: DocumentExtractionInput;
      buffer: Buffer;
      bytesSha256: string;
      requiresAi: boolean;
    };

/**
 * Canonicalizes and validates uploaded bytes before approval. The exact
 * normalized `input` is reused as the provider payload so an approval can
 * never be issued over different file metadata or base64 bytes.
 */
export function prepareDocumentExtractionInput(
  input: DocumentExtractionInput
): PreparedDocumentExtractionInput {
  const fileName = safeFileName(input.fileName);
  const filePolicy = resolveFilePolicy(fileName, input.mediaType);
  const mediaType = filePolicy.mediaType;
  const decoded = parseBase64Payload(input.dataBase64);

  if (
    decoded.declaredMediaType &&
    decoded.declaredMediaType !== "application/octet-stream" &&
    !filePolicy.acceptedMediaTypes.includes(decoded.declaredMediaType)
  ) {
    throw new DocumentValidationError(
      "media_type_mismatch",
      "The encoded document media type does not match its file name and request metadata."
    );
  }

  if (decoded.tooLarge) {
    return { tooLarge: true, fileName, mediaType, requiresAi: false };
  }
  validateFileSignature(decoded.buffer, mediaType);
  return {
    tooLarge: false,
    input: { fileName, mediaType, dataBase64: decoded.base64 },
    buffer: decoded.buffer,
    bytesSha256: createHash("sha256").update(decoded.buffer).digest("hex"),
    requiresAi: !isTextLike(mediaType, fileName)
  };
}

export function documentExtractionApprovalPayload(input: DocumentExtractionInput) {
  const bytes = Buffer.from(input.dataBase64, "base64");
  return {
    document: {
      fileName: input.fileName,
      mediaType: input.mediaType,
      byteLength: bytes.byteLength,
      bytesSha256: createHash("sha256").update(bytes).digest("hex")
    }
  };
}

export type DocumentProviderPass = "primary" | "pdf-image-fallback";

export function documentProviderPasses(input: DocumentExtractionInput): DocumentProviderPass[] {
  return isPdf(input.mediaType, input.fileName)
    ? ["primary", "pdf-image-fallback"]
    : ["primary"];
}

/** Exact provider body used both when an officer approves and at the sink. */
export function buildDocumentProviderRequest(
  input: DocumentExtractionInput,
  lane: AiProviderLane,
  pass: DocumentProviderPass
) {
  if (isImage(input.mediaType)) {
    if (pass !== "primary") {
      throw new DocumentValidationError("unsupported_file_type", "Images have only one extraction pass.");
    }
    return {
      model: lane.model,
      max_tokens: 3000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: input.mediaType,
                data: input.dataBase64
              }
            },
            {
              type: "text",
              text: "Read the visible text in this image. Preserve technical values, tables, labels, and captions."
            }
          ] as never
        }
      ]
    };
  }

  const instruction = pass === "pdf-image-fallback"
    ? "The normal PDF text pass did not produce meaningful text. Treat the PDF pages as scanned images and read the visible page content visually. Return NO_MEANINGFUL_TEXT only if the pages are truly unreadable."
    : isPdf(input.mediaType, input.fileName)
      ? "Extract all meaningful text from this PDF. If selectable text is unavailable or unreadable, return NO_MEANINGFUL_TEXT."
      : "Extract meaningful text from this attached document.";
  return {
    model: lane.model,
    max_tokens: 4200,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: input.mediaType,
              data: input.dataBase64
            },
            title: input.fileName
          },
          { type: "text", text: instruction }
        ] as never
      }
    ]
  };
}

const EXTRACTION_SYSTEM_PROMPT = `You extract useful text from reviewer-supplied documents for an export-control memo workspace.
Return only the text that is visibly present or clearly represented in the file.
Preserve headings, tables, model numbers, technical parameters, units, manufacturer names, dates, and caveats.
Do not summarize, classify, infer missing facts, or add legal analysis.
If the file has no readable content, return the exact phrase NO_MEANINGFUL_TEXT.`;

export async function extractDocumentText(
  input: DocumentExtractionInput,
  options: DocumentExtractionOptions = {}
): Promise<DocumentExtractionResult> {
  const prepared = prepareDocumentExtractionInput(input);
  if (prepared.tooLarge) {
    return {
      fileName: prepared.fileName,
      mediaType: prepared.mediaType,
      text: "",
      method: "unavailable",
      warning: "File is too large for inline extraction. Keep uploads under 4.5 MB for now."
    };
  }
  const { fileName, mediaType } = prepared.input;
  const buffer = prepared.buffer;

  if (isTextLike(mediaType, fileName)) {
    const text = cleanExtractedText(decodeUtf8Text(buffer));
    return {
      fileName,
      mediaType,
      text,
      method: "text",
      warning: hasMeaningfulText(text) ? undefined : "No meaningful text was found in that text file."
    };
  }

  const runtime = getBedrockRuntime();
  const model = runtime.model || DEFAULT_BEDROCK_MODEL;
  const lane = resolveBedrockLane(model);
  if (!runtime.configured || !lane) {
    return {
      fileName,
      mediaType,
      text: "",
      method: "unavailable",
      warning: "Document attached, but Bedrock extraction is not enabled on this backend."
    };
  }

  // A PDF may need a text pass followed by an image-style fallback. Both
  // provider calls share one deadline so the fallback cannot multiply the
  // synchronous edge/Lambda execution budget.
  const totalTimeoutMs = boundedExtractionTimeout(options.timeoutMs);
  const deadlineSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(totalTimeoutMs)])
    : AbortSignal.timeout(totalTimeoutMs);
  const dispatchOptions: DocumentExtractionDispatchOptions = {
    ...options,
    signal: deadlineSignal
  };

  if (isImage(mediaType)) {
    return extractWithBedrockImage(prepared.input, lane, dispatchOptions);
  }

  if (isPdf(mediaType, fileName)) {
    const documentResult = await extractWithBedrockDocument(
      prepared.input,
      lane,
      dispatchOptions,
      "bedrock-document",
      "primary"
    );
    if (hasMeaningfulText(documentResult.text)) return documentResult;

    const imageFallback = await extractWithBedrockDocument(
      prepared.input,
      lane,
      dispatchOptions,
      "pdf-image-fallback",
      "pdf-image-fallback"
    );
    return hasMeaningfulText(imageFallback.text)
      ? imageFallback
      : {
          ...imageFallback,
          warning: "PDF attached, but neither the text pass nor the image-style fallback found meaningful text."
        };
  }

  return extractWithBedrockDocument(
    prepared.input,
    lane,
    dispatchOptions,
    "bedrock-document",
    "primary"
  );
}

async function extractWithBedrockDocument(
  input: DocumentExtractionInput,
  lane: AiProviderLane,
  options: DocumentExtractionDispatchOptions,
  method: DocumentExtractionResult["method"] = "bedrock-document",
  pass: DocumentProviderPass = "primary"
): Promise<DocumentExtractionResult> {
  const startedAt = Date.now();
  const response = await dispatchAuthorizedAiRequest(
    requireDocumentEgress(options, input, pass),
    lane,
    buildDocumentProviderRequest(input, lane, pass),
    {
      signal: options.signal
    },
    options.providerClient
  );
  emitExtractionUsage(options.onUsage, lane.model, response.usage, Date.now() - startedAt);
  return {
    fileName: input.fileName,
    mediaType: input.mediaType,
    text: normalizeModelText(response),
    method
  };
}

async function extractWithBedrockImage(
  input: DocumentExtractionInput,
  lane: AiProviderLane,
  options: DocumentExtractionDispatchOptions
): Promise<DocumentExtractionResult> {
  const startedAt = Date.now();
  const response = await dispatchAuthorizedAiRequest(
    requireDocumentEgress(options, input, "primary"),
    lane,
    buildDocumentProviderRequest(input, lane, "primary"),
    {
      signal: options.signal
    },
    options.providerClient
  );
  emitExtractionUsage(options.onUsage, lane.model, response.usage, Date.now() - startedAt);
  return {
    fileName: input.fileName,
    mediaType: input.mediaType,
    text: normalizeModelText(response),
    method: "bedrock-image",
    warning: hasMeaningfulText(normalizeModelText(response)) ? undefined : "No meaningful text was found in that image."
  };
}

function requireDocumentEgress(
  options: DocumentExtractionOptions,
  input: DocumentExtractionInput,
  pass: DocumentProviderPass
): AiEgressContext {
  if (!options.egress) {
    throw new AiEgressPolicyError(
      "ai_egress_context_required",
      "Document extraction requires a server-owned AI egress classification."
    );
  }
  return {
    ...options.egress,
    dispatchId: `${options.egress.dispatchId}:${pass}`,
    purpose: "document-extraction",
    payload: documentExtractionApprovalPayload(input)
  };
}

function emitExtractionUsage(
  onUsage: ((sample: UsageSample) => void) | undefined,
  model: string,
  usage: unknown,
  latencyMs: number
) {
  const tokenUsage = usage as Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>;
  onUsage?.({
    model,
    callType: "document-extraction",
    inputTokens: tokenUsage.input_tokens ?? 0,
    outputTokens: tokenUsage.output_tokens ?? 0,
    cacheReadTokens: tokenUsage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: tokenUsage.cache_creation_input_tokens ?? 0,
    latencyMs
  });
}

function normalizeModelText(response: { content: Array<{ type: string; text?: string }> }) {
  const text = cleanExtractedText(
    response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
  );
  return /^NO_MEANINGFUL_TEXT\.?$/i.test(text) ? "" : text;
}

function hasMeaningfulText(text: string) {
  const cleaned = cleanExtractedText(text);
  if (cleaned.length < MEANINGFUL_TEXT_CHARS) return false;
  const words = cleaned.match(/[A-Za-z0-9][A-Za-z0-9.+/-]*/g) ?? [];
  return words.length >= MEANINGFUL_WORDS;
}

function cleanExtractedText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

interface ResolvedFilePolicy {
  mediaType: string;
  acceptedMediaTypes: readonly string[];
}

type ParsedBase64Payload =
  | { tooLarge: true; declaredMediaType?: string }
  | { tooLarge: false; declaredMediaType?: string; buffer: Buffer; base64: string };

function resolveFilePolicy(fileName: string, requestedMediaType: string): ResolvedFilePolicy {
  const extension = fileName.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!extension || !Object.prototype.hasOwnProperty.call(FILE_POLICIES, extension)) {
    throw new DocumentValidationError(
      "unsupported_file_type",
      "Supported document types are TXT, Markdown, CSV, JSON, PDF, DOCX, PNG, JPEG, and WebP."
    );
  }

  const policy = FILE_POLICIES[extension];
  const normalizedRequested = normalizeMediaTypeValue(requestedMediaType);
  if (
    normalizedRequested &&
    normalizedRequested !== "application/octet-stream" &&
    !policy.acceptedMediaTypes.includes(normalizedRequested)
  ) {
    throw new DocumentValidationError(
      "media_type_mismatch",
      "The document media type does not match its file extension."
    );
  }

  return {
    mediaType: policy.mediaType,
    acceptedMediaTypes: policy.acceptedMediaTypes
  };
}

function parseBase64Payload(value: string): ParsedBase64Payload {
  if (typeof value !== "string") {
    throw new DocumentValidationError("invalid_base64", "Document data must be valid base64.");
  }

  let encoded = value.trim();
  let declaredMediaType: string | undefined;
  if (encoded.slice(0, 5).toLowerCase() === "data:") {
    const commaIndex = encoded.indexOf(",");
    if (commaIndex < 0) {
      throw new DocumentValidationError("invalid_base64", "The document data URL is malformed.");
    }
    if (commaIndex > MAX_DATA_URL_HEADER_CHARS) {
      throw new DocumentValidationError(
        "invalid_base64",
        "The document data URL metadata exceeds the permitted length."
      );
    }
    const metadata = encoded.slice(5, commaIndex).split(";");
    if (metadata.length - 1 > MAX_DATA_URL_PARAMETERS) {
      throw new DocumentValidationError(
        "invalid_base64",
        "The document data URL contains too many metadata parameters."
      );
    }
    if (!metadata.slice(1).some((part) => part.trim().toLowerCase() === "base64")) {
      throw new DocumentValidationError("invalid_base64", "The document data URL must use base64 encoding.");
    }
    declaredMediaType = normalizeMediaTypeValue(metadata[0]);
    encoded = encoded.slice(commaIndex + 1);
  } else if (encoded.includes(",")) {
    throw new DocumentValidationError("invalid_base64", "Document data must be valid base64.");
  }

  if (encoded.length > MAX_BASE64_CHARS) return { tooLarge: true, declaredMediaType };
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new DocumentValidationError("invalid_base64", "Document data must be valid base64.");
  }

  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength > MAX_FILE_BYTES) return { tooLarge: true, declaredMediaType };
  if (buffer.toString("base64") !== encoded) {
    throw new DocumentValidationError("invalid_base64", "Document data must use canonical base64 encoding.");
  }
  return { tooLarge: false, declaredMediaType, buffer, base64: encoded };
}

function normalizeMediaTypeValue(mediaType: string | undefined) {
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function boundedExtractionTimeout(value: number | undefined) {
  const timeoutMs = value ?? 90_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 110_000) {
    throw new TypeError("Document extraction timeout must be an integer between 1 and 110000 ms.");
  }
  return timeoutMs;
}

function validateFileSignature(buffer: Buffer, mediaType: string) {
  if (isTextLike(mediaType, "")) return;

  let valid = false;
  if (mediaType === "application/pdf") {
    valid = buffer.subarray(0, 1024).includes(Buffer.from("%PDF-", "ascii"));
  } else if (mediaType === "image/png") {
    valid = startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } else if (mediaType === "image/jpeg") {
    valid = startsWithBytes(buffer, [0xff, 0xd8, 0xff]);
  } else if (mediaType === "image/webp") {
    valid = buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  } else if (mediaType === DOCX_MEDIA_TYPE) {
    validateDocxPackage(buffer);
    valid = true;
  }

  if (!valid) {
    throw new DocumentValidationError(
      "file_signature_mismatch",
      "The document contents do not match the declared file type."
    );
  }
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MAX_DOCX_ENTRIES = 512;
const MAX_DOCX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 200;
const REQUIRED_DOCX_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] as const;

interface ZipEntry {
  compressedSize: number;
  compressionMethod: number;
  crc: number;
  dataOffset: number;
  name: string;
  uncompressedSize: number;
}

function validateDocxPackage(buffer: Buffer) {
  if (!startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    throw invalidDocx("The DOCX file does not begin with a ZIP local-file header.");
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  ensureZipRange(buffer, eocdOffset, 22);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw invalidDocx("Multi-disk, empty, and ZIP64 DOCX containers are not accepted.");
  }
  if (entryCount > MAX_DOCX_ENTRIES) {
    throw expansionLimit("The DOCX package contains too many entries.");
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw invalidDocx("The DOCX central directory is missing, overlapping, or inconsistent.");
  }
  ensureZipRange(buffer, centralOffset, centralSize);

  const entries = new Map<string, ZipEntry>();
  const namesIgnoringCase = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let expandedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    ensureZipRange(buffer, cursor, 46);
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER) {
      throw invalidDocx("The DOCX central directory contains an invalid entry header.");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    ensureZipRange(buffer, cursor, recordLength);
    if (
      startDisk !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw invalidDocx("ZIP64 and split DOCX entries are not accepted.");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw invalidDocx("Encrypted DOCX entries are not accepted.");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidDocx("The DOCX package uses an unsupported ZIP compression method.");
    }
    if (nameLength === 0 || nameLength > 1024) {
      throw invalidDocx("The DOCX package contains an invalid entry name.");
    }
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipEntryName(nameBytes, flags);
    validateZipEntryPath(name);
    const foldedName = name.toLowerCase();
    if (entries.has(name) || namesIgnoringCase.has(foldedName)) {
      throw invalidDocx("The DOCX package contains duplicate or case-conflicting entry names.");
    }
    namesIgnoringCase.add(foldedName);
    if (uncompressedSize > MAX_DOCX_ENTRY_BYTES) {
      throw expansionLimit("A DOCX entry exceeds the expanded-size limit.");
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_DOCX_EXPANDED_BYTES) {
      throw expansionLimit("The DOCX package exceeds the aggregate expanded-size limit.");
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw expansionLimit("A non-empty DOCX entry has no bounded compressed representation.");
    }
    if (uncompressedSize / Math.max(1, compressedSize) > MAX_DOCX_COMPRESSION_RATIO) {
      throw expansionLimit("A DOCX entry exceeds the permitted compression ratio.");
    }

    const local = validateLocalZipEntry(
      buffer,
      centralOffset,
      localOffset,
      nameBytes,
      flags,
      compressionMethod,
      crc,
      compressedSize,
      uncompressedSize
    );
    localRanges.push({ start: localOffset, end: local.endOffset });
    entries.set(name, {
      compressedSize,
      compressionMethod,
      crc,
      dataOffset: local.dataOffset,
      name,
      uncompressedSize
    });
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw invalidDocx("The DOCX central-directory size does not match its entries.");
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index - 1].end > localRanges[index].start) {
      throw invalidDocx("The DOCX package contains overlapping local entries.");
    }
  }
  for (const required of REQUIRED_DOCX_PARTS) {
    if (!entries.has(required)) {
      throw invalidDocx(`The DOCX package is missing required OPC part ${required}.`);
    }
  }
  const expandedEntries = new Map<string, Buffer>();
  for (const entry of entries.values()) {
    if (entry.name.endsWith("/")) {
      if (entry.crc !== 0 || entry.compressedSize !== 0 || entry.uncompressedSize !== 0) {
        throw invalidDocx("A DOCX directory entry must not contain compressed or expanded data.");
      }
      continue;
    }
    expandedEntries.set(entry.name, readAndVerifyZipEntry(buffer, entry));
  }
  validateRequiredDocxXml(expandedEntries);
}

function validateLocalZipEntry(
  buffer: Buffer,
  centralOffset: number,
  localOffset: number,
  expectedName: Buffer,
  flags: number,
  compressionMethod: number,
  crc: number,
  compressedSize: number,
  uncompressedSize: number
) {
  if (localOffset >= centralOffset) throw invalidDocx("A DOCX local entry points into the central directory.");
  ensureZipRange(buffer, localOffset, 30);
  if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
    throw invalidDocx("A DOCX central-directory entry has no matching local header.");
  }
  const localFlags = buffer.readUInt16LE(localOffset + 6);
  const localMethod = buffer.readUInt16LE(localOffset + 8);
  const localCrc = buffer.readUInt32LE(localOffset + 14);
  const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
  const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const headerLength = 30 + localNameLength + localExtraLength;
  ensureZipRange(buffer, localOffset, headerLength);
  const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
  if (localFlags !== flags || localMethod !== compressionMethod || !localName.equals(expectedName)) {
    throw invalidDocx("A DOCX local header disagrees with its central-directory entry.");
  }
  if (
    (flags & 0x0008) === 0 &&
    (localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)
  ) {
      throw invalidDocx("A DOCX local header contains inconsistent size or checksum metadata.");
  }
  if (
    (flags & 0x0008) !== 0 &&
    (localCrc !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0)
  ) {
    throw invalidDocx("A descriptor-based DOCX local header must use zero checksum and size placeholders.");
  }
  if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
    throw invalidDocx("A stored DOCX entry has inconsistent compressed and expanded sizes.");
  }
  const dataOffset = localOffset + headerLength;
  if (dataOffset + compressedSize > centralOffset) {
    throw invalidDocx("A DOCX entry overlaps or extends past the central directory.");
  }
  const endOffset = (flags & 0x0008) !== 0
    ? validateZipDataDescriptor(
        buffer,
        dataOffset + compressedSize,
        centralOffset,
        crc,
        compressedSize,
        uncompressedSize
      )
    : dataOffset + compressedSize;
  return { dataOffset, endOffset };
}

function validateZipDataDescriptor(
  buffer: Buffer,
  offset: number,
  centralOffset: number,
  expectedCrc: number,
  expectedCompressedSize: number,
  expectedUncompressedSize: number
) {
  if (offset + 12 > centralOffset) {
    throw invalidDocx("A descriptor-based DOCX entry has a missing or truncated data descriptor.");
  }

  const matches = (fieldOffset: number) =>
    buffer.readUInt32LE(fieldOffset) === expectedCrc &&
    buffer.readUInt32LE(fieldOffset + 4) === expectedCompressedSize &&
    buffer.readUInt32LE(fieldOffset + 8) === expectedUncompressedSize;
  const candidates: number[] = [];

  // The signature is optional. Evaluate both layouts because an unsigned
  // descriptor's CRC is itself allowed to equal the signature value.
  if (matches(offset)) candidates.push(offset + 12);
  if (
    buffer.readUInt32LE(offset) === ZIP_DATA_DESCRIPTOR_SIGNATURE &&
    offset + 16 <= centralOffset &&
    matches(offset + 4)
  ) {
    candidates.push(offset + 16);
  }

  if (candidates.length !== 1) {
    throw invalidDocx(
      candidates.length > 1
        ? "A DOCX data descriptor has an ambiguous signed/unsigned representation."
        : "A DOCX data descriptor does not match its central-directory checksum and sizes."
    );
  }
  return candidates[0];
}

function validateRequiredDocxXml(entries: Map<string, Buffer>) {
  const contentTypes = decodeRequiredZipText(entries, "[Content_Types].xml");
  const rootRelationships = decodeRequiredZipText(entries, "_rels/.rels");
  const document = decodeRequiredZipText(entries, "word/document.xml");
  if (
    !contentTypes.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") ||
    !/PartName\s*=\s*["']\/word\/document\.xml["']/i.test(contentTypes)
  ) {
    throw invalidDocx("The DOCX content-types part does not identify word/document.xml.");
  }
  if (
    !/Type\s*=\s*["'][^"']*\/officeDocument["']/i.test(rootRelationships) ||
    !/Target\s*=\s*["']\/?word\/document\.xml["']/i.test(rootRelationships)
  ) {
    throw invalidDocx("The DOCX root relationships do not target word/document.xml.");
  }
  if (
    !/<(?:\w+:)?document\b/i.test(document) ||
    !document.includes("wordprocessingml")
  ) {
    throw invalidDocx("The DOCX main part is not a WordprocessingML document.");
  }
}

function readAndVerifyZipEntry(buffer: Buffer, entry: ZipEntry) {
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let expanded: Buffer;
  try {
    expanded = entry.compressionMethod === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, {
          maxOutputLength: Math.min(entry.uncompressedSize + 1, MAX_DOCX_ENTRY_BYTES + 1)
        });
  } catch {
    throw invalidDocx(`The DOCX part ${entry.name} cannot be safely decompressed.`);
  }
  if (expanded.length !== entry.uncompressedSize || crc32(expanded) !== entry.crc) {
    throw invalidDocx(`The DOCX part ${entry.name} has invalid size or checksum metadata.`);
  }
  return expanded;
}

function decodeRequiredZipText(entries: Map<string, Buffer>, name: string) {
  const expanded = entries.get(name);
  if (!expanded) throw invalidDocx(`The DOCX package is missing required OPC part ${name}.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(expanded);
  } catch {
    throw invalidDocx(`The DOCX part ${name} is not valid UTF-8 XML.`);
  }
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw invalidDocx("The DOCX ZIP end-of-central-directory record is missing or truncated.");
}

function decodeZipEntryName(value: Buffer, flags: number) {
  if ((flags & 0x0800) === 0 && value.some((byte) => byte > 0x7f)) {
    throw invalidDocx("Non-ASCII DOCX entry names must use the ZIP UTF-8 flag.");
  }
  try {
    return new TextDecoder((flags & 0x0800) !== 0 ? "utf-8" : "ascii", { fatal: true }).decode(value);
  } catch {
    throw invalidDocx("The DOCX package contains an invalid entry name encoding.");
  }
}

function validateZipEntryPath(name: string) {
  const parts = name.split("/");
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\u0000") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    parts.some((part, index) => part === "." || part === ".." || (!part && index < parts.length - 1))
  ) {
    throw invalidDocx("The DOCX package contains an unsafe OPC part path.");
  }
}

function ensureZipRange(buffer: Buffer, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw invalidDocx("The DOCX ZIP metadata points outside the uploaded file.");
  }
}

function invalidDocx(message: string) {
  return new DocumentValidationError("invalid_docx_container", message);
}

function expansionLimit(message: string) {
  return new DocumentValidationError("document_expansion_limit", message);
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function startsWithBytes(buffer: Buffer, expected: number[]) {
  return buffer.length >= expected.length && expected.every((byte, index) => buffer[index] === byte);
}

function decodeUtf8Text(buffer: Buffer) {
  if (buffer.some((byte) => byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d))) {
    throw new DocumentValidationError(
      "file_signature_mismatch",
      "The text document contains binary control bytes."
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new DocumentValidationError(
      "file_signature_mismatch",
      "The text document is not valid UTF-8."
    );
  }
}

function safeFileName(fileName: string) {
  return fileName.replace(/[^\w .()[\]-]/g, "_").slice(0, 140) || "attached-document";
}

function isTextLike(mediaType: string, fileName: string) {
  const lower = fileName.toLowerCase();
  return mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".json");
}

function isImage(mediaType: string) {
  return mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp";
}

function isPdf(mediaType: string, fileName: string) {
  return mediaType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
}
