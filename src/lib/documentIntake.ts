import type { MemoRecord } from "../types";

export interface IntakeResult {
  memo: MemoRecord;
  warning?: string;
}

export async function memoFromFile(file: File): Promise<IntakeResult> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const supportedText = ["txt", "md", "csv", "json"].includes(extension) || file.type.startsWith("text/");
  const now = new Date().toISOString().slice(0, 10);

  if (!supportedText) {
    return {
      memo: {
        id: `upload-${crypto.randomUUID()}`,
        title: file.name.replace(/\.[^.]+$/, "") || "Uploaded memo",
        itemFamily: "Uploaded document",
        owner: "You",
        updatedAt: now,
        documentCode: `UPLOAD-${now.replaceAll("-", "")}`,
        status: "draft",
        attachments: [file.name],
        memoText: `Uploaded attachment: ${file.name}

Browser prototype intake captured the file metadata. The production AWS intake path will OCR/parse PDF, DOCX, scanned image, and email attachments with the backend extraction workers before AI review.

Paste or upload extracted memo text to run the local council analysis in this prototype.`
      },
      warning:
        "Binary document captured. Production parsing is documented for AWS Textract/workers; this browser prototype analyzes text uploads."
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
      memoText: text.trim() || "No text content found."
    }
  };
}

function inferItemFamily(text: string) {
  if (/cryogenic|cryostat|pulse tube/i.test(text)) return "Cryogenic laboratory equipment";
  if (/camera|imaging|CMOS/i.test(text)) return "Imaging sensor module";
  if (/laser|wavelength|pulse/i.test(text)) return "Laser source";
  if (/quantum|microwave|RF|qubit/i.test(text)) return "Signal/control electronics";
  return "Uploaded item";
}

