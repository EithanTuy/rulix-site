// @vitest-environment node

import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentValidationError,
  extractDocumentText
} from "./documentExtraction";
import {
  setAiDispatchAdmissionHook,
  setAiDispatchAuthorizationHook,
  type AiProviderClient
} from "./aiEgressGateway";

const originalEnv = { ...process.env };

describe("document extraction input validation", () => {
  beforeEach(() => {
    delete process.env.BEDROCK_ENABLED;
  });

  afterEach(() => {
    setAiDispatchAdmissionHook(undefined);
    setAiDispatchAuthorizationHook(undefined);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
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

  it("accepts a structurally valid minimal DOCX before reporting provider availability", async () => {
    const docx = minimalDocx();
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

  it.each(["signed", "unsigned"] as const)(
    "accepts a DOCX entry with a valid %s data descriptor",
    async (descriptor) => {
      const docx = minimalDocx([{
        name: `word/${descriptor}-descriptor.bin`,
        data: Buffer.from("descriptor-backed OPC part"),
        method: 8,
        descriptor
      }]);

      const result = await extractDocumentText({
        fileName: `${descriptor}-descriptor.docx`,
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        dataBase64: docx.toString("base64")
      });

      expect(result.method).toBe("unavailable");
    }
  );

  it.each([
    ["missing", { descriptor: "missing" as const }],
    ["truncated", { descriptor: "signed" as const, descriptorTruncateBytes: 4 }]
  ])("rejects a %s DOCX data descriptor", async (_label, descriptorOptions) => {
    const docx = minimalDocx([{
      name: "word/broken-descriptor.bin",
      data: Buffer.from("descriptor-backed OPC part"),
      method: 8,
      ...descriptorOptions
    }]);

    await expect(extractDocumentText({
      fileName: "broken-descriptor.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: docx.toString("base64")
    })).rejects.toMatchObject({ code: "invalid_docx_container" });
  });

  it.each([
    ["CRC", { descriptorCrc: 1 }],
    ["compressed size", { descriptorCompressedSize: 1 }],
    ["expanded size", { descriptorUncompressedSize: 1 }]
  ])("rejects a DOCX descriptor with mismatched %s", async (_label, descriptorOverrides) => {
    const docx = minimalDocx([{
      name: "word/mismatched-descriptor.bin",
      data: Buffer.from("descriptor-backed OPC part"),
      method: 8,
      descriptor: "signed",
      ...descriptorOverrides
    }]);

    await expect(extractDocumentText({
      fileName: "mismatched-descriptor.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: docx.toString("base64")
    })).rejects.toMatchObject({ code: "invalid_docx_container" });
  });

  it("rejects a descriptor that aliases the beginning of the next local entry", async () => {
    const docx = minimalDocx([
      {
        name: "word/confused-descriptor.bin",
        data: Buffer.alloc(8),
        compressedData: Buffer.alloc(20),
        declaredCrc: 0x04034b50,
        declaredUncompressedSize: 8,
        descriptor: "missing",
        method: 8,
        utf8: false
      },
      {
        name: "word/next-entry.bin",
        data: Buffer.from("next entry"),
        method: 8,
        utf8: false
      }
    ]);

    await expect(extractDocumentText({
      fileName: "descriptor-overlap.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: docx.toString("base64")
    })).rejects.toThrow("overlapping local entries");
  });

  it("rejects the previous marker-only fake DOCX", async () => {
    const fake = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml\u0000word/document.xml", "ascii")
    ]);

    await expect(extractDocumentText({
      fileName: "fake.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: fake.toString("base64")
    })).rejects.toMatchObject({ code: "invalid_docx_container" });
  });

  it("rejects a truncated DOCX central directory", async () => {
    const truncated = minimalDocx().subarray(0, -9);

    await expect(extractDocumentText({
      fileName: "truncated.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: truncated.toString("base64")
    })).rejects.toMatchObject({ code: "invalid_docx_container" });
  });

  it("rejects unsafe OPC part paths", async () => {
    const unsafe = minimalDocx([{ name: "../outside.xml", data: Buffer.from("<x/>") }]);

    await expect(extractDocumentText({
      fileName: "unsafe.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: unsafe.toString("base64")
    })).rejects.toMatchObject({ code: "invalid_docx_container" });
  });

  it("rejects expansion-heavy DOCX metadata before decompression", async () => {
    const bomb = minimalDocx([{
      name: "word/bomb.bin",
      data: Buffer.alloc(16, 0x41),
      method: 8,
      declaredUncompressedSize: 20 * 1024 * 1024
    }]);

    await expect(extractDocumentText({
      fileName: "bomb.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: bomb.toString("base64")
    })).rejects.toMatchObject({ code: "document_expansion_limit" });
  });

  it("bounded-inflates every non-required entry and rejects a hidden size lie", async () => {
    const hiddenExpansion = Buffer.alloc(64 * 1024, 0x41);
    const docx = minimalDocx([{
      name: "customXml/hidden.bin",
      data: hiddenExpansion,
      method: 8,
      declaredUncompressedSize: 1
    }]);

    await expect(extractDocumentText({
      fileName: "hidden-bomb.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: docx.toString("base64")
    })).rejects.toMatchObject({ code: "invalid_docx_container" });
  });

  it("rejects non-empty directory entries instead of skipping their compressed payload", async () => {
    const docx = minimalDocx([{
      name: "customXml/",
      data: Buffer.alloc(64 * 1024, 0x41),
      method: 8,
      declaredUncompressedSize: 1
    }]);

    await expect(extractDocumentText({
      fileName: "directory-payload.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataBase64: docx.toString("base64")
    })).rejects.toThrow("directory entry must not contain");
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

  it("rejects oversized data-URL metadata before allocation-heavy parameter parsing", async () => {
    const extraction = extractDocumentText({
      fileName: "memo.txt",
      mediaType: "text/plain",
      dataBase64: `data:text/plain${";x".repeat(50_000)};base64,QQ==`
    });

    await expect(extraction).rejects.toMatchObject({ code: "invalid_base64" });
  });

  it("rejects excessive data-URL parameters even when the header is short", async () => {
    const parameters = Array.from({ length: 16 }, (_, index) => `p${index}=x`).join(";");
    const extraction = extractDocumentText({
      fileName: "memo.txt",
      mediaType: "text/plain",
      dataBase64: `data:text/plain;${parameters};base64,QQ==`
    });

    await expect(extraction).rejects.toMatchObject({ code: "invalid_base64" });
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

  it("denies a classification below the deployment floor with zero provider calls", async () => {
    enableApprovedBedrock();
    const { client, create } = extractionProvider();

    await expect(extractDocumentText(validPdf(), {
      providerClient: client,
      egress: documentEgress("public", "document-denied-floor")
    })).rejects.toMatchObject({ code: "ai_data_class_below_floor" });
    expect(create).not.toHaveBeenCalled();
  });

  it("denies a stale approved region with zero provider calls", async () => {
    enableApprovedBedrock();
    process.env.RULIX_APPROVED_REGION = "us-west-2";
    const { client, create } = extractionProvider();

    await expect(extractDocumentText(validPdf(), {
      providerClient: client,
      egress: documentEgress("proprietary", "document-denied-region")
    })).rejects.toMatchObject({ code: "ai_egress_lane_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("dispatches an exactly authorized PDF once and records extraction", async () => {
    enableApprovedBedrock();
    setAiDispatchAdmissionHook(async () => ({ settle: async () => undefined }));
    const { client, create } = extractionProvider(longExtractedText());

    const result = await extractDocumentText(validPdf(), {
      providerClient: client,
      egress: documentEgress("proprietary", "document-authorized")
    });

    expect(result).toMatchObject({ method: "bedrock-document", text: longExtractedText() });
    expect(create).toHaveBeenCalledOnce();
  });

  it("admits and settles each PDF fallback provider attempt independently", async () => {
    enableApprovedBedrock();
    const settled: string[] = [];
    const admission = vi.fn(async () => ({
      settle: async (result: { status: string }) => {
        settled.push(result.status);
      }
    }));
    setAiDispatchAdmissionHook(admission);
    const responses = ["NO_MEANINGFUL_TEXT", longExtractedText()];
    const { client, create } = extractionProvider(() => responses.shift()!);

    const result = await extractDocumentText(validPdf(), {
      providerClient: client,
      egress: documentEgress("proprietary", "document-fallback")
    });

    expect(result.method).toBe("pdf-image-fallback");
    expect(create).toHaveBeenCalledTimes(2);
    const firstOptions = create.mock.calls[0][1] as { signal?: AbortSignal };
    const secondOptions = create.mock.calls[1][1] as { signal?: AbortSignal };
    expect(firstOptions.signal).toBeInstanceOf(AbortSignal);
    expect(secondOptions.signal).toBe(firstOptions.signal);
    expect(admission).toHaveBeenCalledTimes(2);
    expect(settled).toEqual(["succeeded", "succeeded"]);
  });
});

function asDataUrl(mediaType: string, value: string) {
  return `data:${mediaType};base64,${Buffer.from(value, "utf8").toString("base64")}`;
}

interface ZipFixtureEntry {
  name: string;
  data: Buffer;
  compressedData?: Buffer;
  declaredCrc?: number;
  method?: 0 | 8;
  declaredUncompressedSize?: number;
  descriptor?: "signed" | "unsigned" | "missing";
  descriptorCompressedSize?: number;
  descriptorCrc?: number;
  descriptorTruncateBytes?: number;
  descriptorUncompressedSize?: number;
  utf8?: boolean;
}

function minimalDocx(extraEntries: ZipFixtureEntry[] = []) {
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      )
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      )
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Valid minimal document</w:t></w:r></w:p></w:body></w:document>'
      )
    },
    ...extraEntries
  ]);
}

function buildZip(entries: ZipFixtureEntry[]) {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 0;
    const compressed = entry.compressedData ?? (method === 8 ? deflateRawSync(entry.data) : entry.data);
    const declaredSize = entry.declaredUncompressedSize ?? entry.data.length;
    const crc = entry.declaredCrc ?? crc32(entry.data);
    const flags = (entry.utf8 === false ? 0 : 0x0800) | (entry.descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(declaredSize, 22);
    }
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localRecords.push(local, compressed);

    let descriptor = Buffer.alloc(0);
    if (entry.descriptor && entry.descriptor !== "missing") {
      const signed = entry.descriptor === "signed";
      descriptor = Buffer.alloc(signed ? 16 : 12);
      let descriptorOffset = 0;
      if (signed) {
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptorOffset = 4;
      }
      descriptor.writeUInt32LE(entry.descriptorCrc ?? crc, descriptorOffset);
      descriptor.writeUInt32LE(
        entry.descriptorCompressedSize ?? compressed.length,
        descriptorOffset + 4
      );
      descriptor.writeUInt32LE(
        entry.descriptorUncompressedSize ?? declaredSize,
        descriptorOffset + 8
      );
      if (entry.descriptorTruncateBytes) {
        descriptor = descriptor.subarray(0, Math.max(0, descriptor.length - entry.descriptorTruncateBytes));
      }
      localRecords.push(descriptor);
    }

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length + compressed.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function enableApprovedBedrock() {
  process.env.BEDROCK_ENABLED = "true";
  process.env.AWS_REGION = "us-east-1";
  process.env.RULIX_APPROVED_PROVIDER = "amazon-bedrock";
  process.env.RULIX_APPROVED_REGION = "us-east-1";
  process.env.RULIX_AI_DATA_CLASS = "proprietary";
  setAiDispatchAuthorizationHook(async () => ({
    replayed: false,
    markProviderStarted: async () => undefined,
    settle: async () => undefined
  }));
}

function documentEgress(dataClass: "public" | "proprietary", dispatchId: string) {
  return {
    accountId: "account-1",
    dataClass,
    approvalId: "document-approval",
    dispatchId,
    subject: {
      kind: "document" as const,
      id: "document-test",
      version: 1,
      contentHash: "c".repeat(64)
    }
  };
}

function validPdf() {
  return {
    fileName: "memo.pdf",
    mediaType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF").toString("base64")
  };
}

function longExtractedText() {
  return "Model RLX-200 technical specification lists wavelength, output power, dimensions, firmware, interfaces, operating temperature, intended use, manufacturer, part number, revision, compliance notes, and verification details for reviewer analysis.";
}

function extractionProvider(text: string | (() => string) = longExtractedText()) {
  const create = vi.fn(async (_body: unknown, _options?: unknown) => ({
    content: [{ type: "text", text: typeof text === "function" ? text() : text }],
    usage: { input_tokens: 20, output_tokens: 10 }
  }));
  const client: AiProviderClient = { messages: { create } };
  return { client, create };
}
