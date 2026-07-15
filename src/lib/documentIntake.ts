import type { DataClass, MemoRecord } from "../types";
import { extractDocument, type DocumentExtraction } from "./apiClient";

export interface IntakeResult {
  memo: MemoRecord;
  warning?: string;
}

export async function memoFromFile(file: File, dataClass: DataClass): Promise<IntakeResult> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const supportedText = ["txt", "md", "csv", "json"].includes(extension) || file.type.startsWith("text/");
  const now = new Date().toISOString().slice(0, 10);

  if (!supportedText) {
    const extraction = await extractFileText(file, dataClass);
    const extractedText = extraction.text.trim();
    return {
      memo: {
        id: `upload-${crypto.randomUUID()}`,
        title: file.name.replace(/\.[^.]+$/, "") || "Uploaded memo",
        itemFamily: extractedText ? inferItemFamily(extractedText) : "Uploaded document",
        owner: "You",
        updatedAt: now,
        documentCode: `UPLOAD-${now.replaceAll("-", "")}`,
        status: "draft",
        attachments: [file.name],
        dataClass,
        memoText: extractedText
          ? formatExtractedAttachment(file.name, extraction)
          : `Uploaded attachment: ${file.name}

${extraction.warning ?? "No meaningful text was extracted from this attachment."}

Add memo text manually or upload a clearer document before AI review.`
      },
      warning: extraction.warning ?? extractionWarning(extraction)
    };
  }

  const text = await file.text();

  return {
    memo: {
      id: `upload-${crypto.randomUUID()}`,
      title: file.name.replace(/\.[^.]+$/, "") || "Uploaded memo",
      itemFamily: inferItemFamily(text),
      owner: "You",
      updatedAt: now,
      documentCode: `UPLOAD-${now.replaceAll("-", "")}`,
      status: "draft",
      attachments: [file.name],
      dataClass,
      memoText: text.trim() || "No text content found."
    }
  };
}

export async function extractFileText(file: File, dataClass: DataClass): Promise<DocumentExtraction> {
  if (file.type.startsWith("text/") || /\.(txt|md|csv|json)$/i.test(file.name)) {
    return {
      fileName: file.name,
      mediaType: file.type || mediaTypeFromName(file.name),
      text: (await file.text()).trim(),
      method: "text"
    };
  }
  return extractDocument({
    fileName: file.name,
    mediaType: file.type || mediaTypeFromName(file.name),
    dataBase64: await fileToBase64(file),
    dataClass
  });
}

export function formatExtractedAttachment(fileName: string, extraction: DocumentExtraction) {
  const methodLabel = extraction.method === "pdf-image-fallback"
    ? "PDF image fallback"
    : extraction.method === "bedrock-image"
      ? "image extraction"
      : extraction.method === "bedrock-document"
        ? "document extraction"
        : "text extraction";
  return `# Extracted document: ${fileName}

Extraction method: ${methodLabel}

${extraction.text.trim()}`;
}

function inferItemFamily(text: string) {
  if (/cryogenic|cryostat|pulse tube/i.test(text)) return "Cryogenic laboratory equipment";
  if (/camera|imaging|CMOS/i.test(text)) return "Imaging sensor module";
  if (/laser|wavelength|pulse/i.test(text)) return "Laser source";
  if (/quantum|microwave|\bRF\b|qubit/i.test(text)) return "Signal/control electronics";
  return "Uploaded item";
}

function extractionWarning(extraction: DocumentExtraction) {
  if (extraction.method === "pdf-image-fallback") {
    return `Uploaded ${extraction.fileName}. Normal PDF text extraction was empty, so Rulix used the image-style fallback. Review the extracted text before analysis.`;
  }
  if (extraction.method === "bedrock-image") {
    return `Uploaded ${extraction.fileName}. Rulix read the image content into memo text.`;
  }
  if (extraction.method === "bedrock-document") {
    return `Uploaded ${extraction.fileName}. Rulix extracted document text for review.`;
  }
  return undefined;
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read file."));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function mediaTypeFromName(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}
