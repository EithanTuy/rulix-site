import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { DEFAULT_BEDROCK_MODEL, getBedrockRuntime, type UsageSample } from "./bedrockCouncil";

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
}

const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;
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

const EXTRACTION_SYSTEM_PROMPT = `You extract useful text from reviewer-supplied documents for an export-control memo workspace.
Return only the text that is visibly present or clearly represented in the file.
Preserve headings, tables, model numbers, technical parameters, units, manufacturer names, dates, and caveats.
Do not summarize, classify, infer missing facts, or add legal analysis.
If the file has no readable content, return the exact phrase NO_MEANINGFUL_TEXT.`;

export async function extractDocumentText(
  input: DocumentExtractionInput,
  options: DocumentExtractionOptions = {}
): Promise<DocumentExtractionResult> {
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
    return {
      fileName,
      mediaType,
      text: "",
      method: "unavailable",
      warning: "File is too large for inline extraction. Keep uploads under 4.5 MB for now."
    };
  }

  const buffer = decoded.buffer;
  validateFileSignature(buffer, mediaType);

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
  if (!runtime.configured) {
    return {
      fileName,
      mediaType,
      text: "",
      method: "unavailable",
      warning: "Document attached, but Bedrock extraction is not enabled on this backend."
    };
  }

  if (isImage(mediaType)) {
    return extractWithBedrockImage({ fileName, mediaType, dataBase64: decoded.base64 }, model, options);
  }

  if (isPdf(mediaType, fileName)) {
    const documentResult = await extractWithBedrockDocument(
      { fileName, mediaType: "application/pdf", dataBase64: decoded.base64 },
      model,
      options,
      "Extract all meaningful text from this PDF. If selectable text is unavailable or unreadable, return NO_MEANINGFUL_TEXT."
    );
    if (hasMeaningfulText(documentResult.text)) return documentResult;

    const imageFallback = await extractWithBedrockDocument(
      { fileName, mediaType: "application/pdf", dataBase64: decoded.base64 },
      model,
      options,
      "The normal PDF text pass did not produce meaningful text. Treat the PDF pages as scanned images and read the visible page content visually. Return NO_MEANINGFUL_TEXT only if the pages are truly unreadable.",
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
    { fileName, mediaType, dataBase64: decoded.base64 },
    model,
    options,
    "Extract meaningful text from this attached document."
  );
}

async function extractWithBedrockDocument(
  input: DocumentExtractionInput,
  model: string,
  options: DocumentExtractionOptions,
  instruction: string,
  method: DocumentExtractionResult["method"] = "bedrock-document"
): Promise<DocumentExtractionResult> {
  const startedAt = Date.now();
  const client = new AnthropicBedrock();
  const response = await client.messages.create(
    {
      model,
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
                data: stripBase64Prefix(input.dataBase64)
              },
              title: input.fileName
            },
            {
              type: "text",
              text: instruction
            }
          ] as never
        }
      ]
    },
    {
      signal: AbortSignal.timeout(options.timeoutMs ?? 90000),
      maxRetries: 0
    }
  );
  emitExtractionUsage(options.onUsage, model, response.usage, Date.now() - startedAt);
  return {
    fileName: input.fileName,
    mediaType: input.mediaType,
    text: normalizeModelText(response),
    method
  };
}

async function extractWithBedrockImage(
  input: DocumentExtractionInput,
  model: string,
  options: DocumentExtractionOptions
): Promise<DocumentExtractionResult> {
  const startedAt = Date.now();
  const client = new AnthropicBedrock();
  const response = await client.messages.create(
    {
      model,
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
                data: stripBase64Prefix(input.dataBase64)
              }
            },
            {
              type: "text",
              text: "Read the visible text in this image. Preserve technical values, tables, labels, and captions."
            }
          ] as never
        }
      ]
    },
    {
      signal: AbortSignal.timeout(options.timeoutMs ?? 90000),
      maxRetries: 0
    }
  );
  emitExtractionUsage(options.onUsage, model, response.usage, Date.now() - startedAt);
  return {
    fileName: input.fileName,
    mediaType: input.mediaType,
    text: normalizeModelText(response),
    method: "bedrock-image",
    warning: hasMeaningfulText(normalizeModelText(response)) ? undefined : "No meaningful text was found in that image."
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

function stripBase64Prefix(value: string) {
  return value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
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
  if (!extension || !Object.hasOwn(FILE_POLICIES, extension)) {
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
  if (encoded.toLowerCase().startsWith("data:")) {
    const commaIndex = encoded.indexOf(",");
    if (commaIndex < 0) {
      throw new DocumentValidationError("invalid_base64", "The document data URL is malformed.");
    }
    const metadata = encoded.slice(5, commaIndex).split(";");
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
    valid = startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) &&
      buffer.includes(Buffer.from("[Content_Types].xml", "ascii")) &&
      buffer.includes(Buffer.from("word/", "ascii"));
  }

  if (!valid) {
    throw new DocumentValidationError(
      "file_signature_mismatch",
      "The document contents do not match the declared file type."
    );
  }
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
