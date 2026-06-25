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
const MEANINGFUL_TEXT_CHARS = 80;
const MEANINGFUL_WORDS = 12;
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
  const mediaType = normalizeMediaType(input.mediaType, fileName);
  const buffer = decodeBase64(input.dataBase64);

  if (buffer.byteLength > MAX_FILE_BYTES) {
    return {
      fileName,
      mediaType,
      text: "",
      method: "unavailable",
      warning: "File is too large for inline extraction. Keep uploads under 4.5 MB for now."
    };
  }

  if (isTextLike(mediaType, fileName)) {
    const text = cleanExtractedText(buffer.toString("utf8"));
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
    return extractWithBedrockImage({ fileName, mediaType, dataBase64: input.dataBase64 }, model, options);
  }

  if (isPdf(mediaType, fileName)) {
    const documentResult = await extractWithBedrockDocument(
      { fileName, mediaType: "application/pdf", dataBase64: input.dataBase64 },
      model,
      options,
      "Extract all meaningful text from this PDF. If selectable text is unavailable or unreadable, return NO_MEANINGFUL_TEXT."
    );
    if (hasMeaningfulText(documentResult.text)) return documentResult;

    const imageFallback = await extractWithBedrockDocument(
      { fileName, mediaType: "application/pdf", dataBase64: input.dataBase64 },
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
    { fileName, mediaType, dataBase64: input.dataBase64 },
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

function decodeBase64(value: string) {
  return Buffer.from(stripBase64Prefix(value), "base64");
}

function stripBase64Prefix(value: string) {
  return value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
}

function normalizeMediaType(mediaType: string, fileName: string) {
  if (mediaType && mediaType !== "application/octet-stream") return mediaType;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
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
  return mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp" || mediaType === "image/gif";
}

function isPdf(mediaType: string, fileName: string) {
  return mediaType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
}
