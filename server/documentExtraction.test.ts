// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DocumentValidationError,
  extractDocumentText
} from "./documentExtraction";

const originalBedrockEnabled = process.env.BEDROCK_ENABLED;

describe("document extraction input validation", () => {
  beforeEach(() => {
    delete process.env.BEDROCK_ENABLED;
  });

  afterAll(() => {
    if (originalBedrockEnabled === undefined) delete process.env.BEDROCK_ENABLED;
    else process.env.BEDROCK_ENABLED = originalBedrockEnabled;
  });

  it("preserves legitimate UTF-8 text extraction", async () => {
    const result = await extractDocumentText({
      fileName: "laser-spec.txt",
      mediaType: "text/plain",
      dataBase64: asDataUrl("text/plain", "Wavelength: 1550 nm\nOutput power: 20 mW")
    });

    expect(result).toMatchObject({
      fileName: "laser-spec.txt",
      mediaType: "text/plain",
      method: "text",
      text: "Wavelength: 1550 nm\nOutput power: 20 mW"
    });
  });

  it("accepts a browser CSV media-type alias and normalizes it", async () => {
    const result = await extractDocumentText({
      fileName: "laser-spec.csv",
      mediaType: "application/vnd.ms-excel",
      dataBase64: asDataUrl("application/vnd.ms-excel", "parameter,value\nwavelength,1550 nm")
    });

    expect(result).toMatchObject({
      mediaType: "text/csv",
      method: "text"
    });
  });

  it("accepts a DOCX container signature before reporting provider availability", async () => {
    const docx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml\u0000word/document.xml", "ascii")
    ]);
    const result = await extractDocumentText({
      fileName: "laser-spec.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: docx.toString("base64")
    });

    expect(result).toMatchObject({
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      method: "unavailable"
    });
  });

  it("rejects malformed base64 instead of decoding a partial payload", async () => {
    const extraction = extractDocumentText({
      fileName: "memo.txt",
      mediaType: "text/plain",
      dataBase64: "not+valid===base64"
    });
    await expect(extraction).rejects.toBeInstanceOf(DocumentValidationError);
    await expect(extraction).rejects.toMatchObject({
      code: "invalid_base64"
    });
  });

  it("rejects unsupported file extensions and media types", async () => {
    await expect(extractDocumentText({
      fileName: "payload.exe",
      mediaType: "application/octet-stream",
      dataBase64: Buffer.from("MZ").toString("base64")
    })).rejects.toMatchObject({
      code: "unsupported_file_type"
    });
  });

  it("rejects a media type that does not match the file extension", async () => {
    await expect(extractDocumentText({
      fileName: "memo.pdf",
      mediaType: "text/plain",
      dataBase64: asDataUrl("text/plain", "This is not a PDF.")
    })).rejects.toMatchObject({
      code: "media_type_mismatch"
    });
  });

  it("rejects a data URL media type that disagrees with request metadata", async () => {
    await expect(extractDocumentText({
      fileName: "memo.pdf",
      mediaType: "application/pdf",
      dataBase64: asDataUrl("image/png", "%PDF-1.7\n")
    })).rejects.toMatchObject({
      code: "media_type_mismatch"
    });
  });

  it("rejects disguised binary files whose magic bytes do not match", async () => {
    await expect(extractDocumentText({
      fileName: "memo.pdf",
      mediaType: "application/pdf",
      dataBase64: Buffer.from("plain text wearing a PDF extension").toString("base64")
    })).rejects.toMatchObject({
      code: "file_signature_mismatch"
    });
  });

  it("accepts a supported PDF signature before reporting provider availability", async () => {
    const result = await extractDocumentText({
      fileName: "memo.pdf",
      mediaType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF").toString("base64")
    });

    expect(result).toMatchObject({
      mediaType: "application/pdf",
      method: "unavailable"
    });
  });

  it("rejects binary bytes disguised as a text document", async () => {
    await expect(extractDocumentText({
      fileName: "memo.txt",
      mediaType: "text/plain",
      dataBase64: Buffer.from([0x41, 0x00, 0x42]).toString("base64")
    })).rejects.toMatchObject({
      code: "file_signature_mismatch"
    });
  });

  it("rejects oversized payloads from encoded length before decoding", async () => {
    const encoded = "AAAA".repeat(Math.ceil((4.5 * 1024 * 1024 + 1) / 3));
    const result = await extractDocumentText({
      fileName: "too-large.pdf",
      mediaType: "application/pdf",
      dataBase64: encoded
    });

    expect(result).toMatchObject({
      method: "unavailable",
      warning: expect.stringContaining("under 4.5 MB")
    });
  });
});

function asDataUrl(mediaType: string, value: string) {
  return `data:${mediaType};base64,${Buffer.from(value, "utf8").toString("base64")}`;
}
