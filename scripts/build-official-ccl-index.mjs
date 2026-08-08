import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const rawManifestPath = path.resolve("corpus", "manifest.generated.json");
const rawManifest = JSON.parse(await readFile(rawManifestPath, "utf8"));
if (rawManifest.schemaVersion !== "rulix.regulatory-corpus-manifest/v1") {
  throw new Error("The generated corpus manifest uses an unsupported schema.");
}

const requiredSourceIds = [
  "ear-734", "ear-738", "ear-740", "ear-742", "ear-744", "ear-746", "ear-748", "ear-762", "ear-772",
  "ear-774-supp-1", "ear-774-supp-2", "ear-774-supp-4", "itar-120", "itar-121", "ddtc-commodity-jurisdiction"
];
const missingSources = requiredSourceIds.filter((id) => !rawManifest.sources.some((source) => source.id === id));
if (missingSources.length) throw new Error(`The generated corpus is incomplete: ${missingSources.join(", ")}.`);

const cclSource = rawManifest.sources.find((source) => source.id === "ear-774-supp-1");
if (!cclSource) throw new Error("The generated corpus manifest does not contain ear-774-supp-1.");
const xmlPath = path.resolve("corpus", "raw", ...cclSource.rawFile.split("/"));
const xmlBytes = await readFile(xmlPath);
const actualSourceHash = sha256(xmlBytes);
if (actualSourceHash !== cclSource.rawByteHash) {
  throw new Error(`CCL source checksum mismatch: expected ${cclSource.rawByteHash}, received ${actualSourceHash}.`);
}
const xml = xmlBytes.toString("utf8");

const document = new JSDOM(xml, { contentType: "text/xml" }).window.document;
const entryElements = [...document.querySelectorAll("FP-2")].filter(isEntryStart);
if (entryElements.length < 600) {
  throw new Error(`Malformed or incomplete CCL XML: only ${entryElements.length} ECCN headings were found.`);
}

const entries = entryElements.map(parseEntry);
const identifiers = new Set(entries.map((entry) => entry.eccn));
if (identifiers.size !== entries.length) {
  throw new Error("Malformed CCL XML: duplicate ECCN identifiers were found.");
}
if (!identifiers.has("3A001") || !identifiers.has("5A002") || !identifiers.has("5A992") || !identifiers.has("6A003") || !identifiers.has("6A005")) {
  throw new Error("Malformed or incomplete CCL XML: required regression entries are absent.");
}

const snapshotBase = {
  schemaVersion: "rulix.ccl-index/v3",
  snapshotId: `ecfr-ccl-${cclSource.pointInTimeDate}-${cclSource.rawByteHash.slice(0, 12)}`,
  pointInTimeDate: cclSource.pointInTimeDate,
  effectiveAt: cclSource.effectiveFrom,
  currentThrough: cclSource.currentThrough,
  retrievedAt: cclSource.retrievedAt,
  parserVersion: "rulix-ccl-xml-parser/3",
  corpusBuildVersion: rawManifest.corpusBuildVersion,
  reviewStatus: rawManifest.reviewStatus,
  requiredSourceIds,
  source: {
    id: cclSource.id,
    title: cclSource.title,
    citation: cclSource.citation,
    url: cclSource.canonicalUrl,
    apiUrl: cclSource.apiUrl,
    rawByteHash: cclSource.rawByteHash,
    byteLength: cclSource.byteLength,
    rawFile: cclSource.rawFile,
    verificationStatus: cclSource.verificationStatus
  },
  entryCount: entries.length,
  entries
};
const snapshot = { ...snapshotBase, checksum: sha256(stableJson(snapshotBase)) };
const metadata = {
  schemaVersion: snapshot.schemaVersion,
  snapshotId: snapshot.snapshotId,
  checksum: snapshot.checksum,
  pointInTimeDate: snapshot.pointInTimeDate,
  effectiveAt: snapshot.effectiveAt,
  currentThrough: snapshot.currentThrough,
  entryCount: snapshot.entryCount,
  reviewStatus: snapshot.reviewStatus
};

await Promise.all([
  mkdir(path.resolve("corpus", "generated"), { recursive: true }),
  mkdir(path.resolve("server", "data"), { recursive: true }),
  mkdir(path.resolve("src", "data"), { recursive: true })
]);
await writeFile(
  path.resolve("corpus", "generated", "ccl-index.json"),
  `${JSON.stringify(snapshot)}\n`,
  "utf8"
);
await writeFile(
  path.resolve("server", "data", "ccl-index.generated.json"),
  `${JSON.stringify(snapshot)}\n`,
  "utf8"
);
await writeFile(
  path.resolve("src", "data", "ccl-metadata.generated.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8"
);
await writeFile(
  path.resolve("corpus", "generated", "manifest.json"),
  `${JSON.stringify(rawManifest, null, 2)}\n`,
  "utf8"
);
console.log(`Built pending snapshot ${snapshot.snapshotId} with ${entries.length} unique ECCNs (${snapshot.checksum}).`);
console.log("A qualified reviewer must create an explicit review record before consequential use.");

function isEntryStart(element) {
  return /^\s*[0-9][A-E][0-9]{3}\b/i.test(normalizeText(element.textContent));
}

function parseEntry(element) {
  const headingText = normalizeText(element.textContent);
  const match = headingText.match(/^([0-9][A-E][0-9]{3})\s+([\s\S]+)$/i);
  if (!match) throw new Error(`Malformed ECCN heading: ${headingText.slice(0, 120)}`);
  const eccn = match[1].toUpperCase();
  const blocks = [];
  for (let current = element.nextElementSibling; current && !isEntryStart(current); current = current.nextElementSibling) {
    const text = normalizeText(current.textContent);
    if (!text) continue;
    const blockIndex = blocks.length;
    blocks.push({
      blockIndex,
      tag: current.tagName,
      kind: blockKind(current.tagName, text),
      paragraphLabel: paragraphLabel(text),
      text,
      textHash: sha256(text),
      locator: `${cclSource.citation}, ECCN ${eccn}, block ${blockIndex + 1}`
    });
  }
  const sections = splitSections(blocks);
  const fullText = [headingText, ...blocks.map((block) => block.text)].join("\n");
  const notes = blocks
    .filter((block) => block.kind === "note")
    .map((block) => ({ locator: block.locator, text: block.text, textHash: block.textHash }));
  const definitions = unique([...fullText.matchAll(/[\u201c"]([^\u201d"]{2,80})[\u201d"]/g)].map((value) => value[1]));
  const crossReferences = unique([
    ...fullText.matchAll(/(?<![A-Z0-9])[0-9][A-E][0-9]{3}(?:\.[A-Z0-9]+)*(?![A-Z0-9])/gi)
  ].flatMap((value) => {
    const specific = value[0].replace(/\.+$/, "").toUpperCase();
    const base = specific.slice(0, 5);
    return specific === base ? [base] : [base, specific];
  }).filter((value) => value !== eccn));
  return {
    eccn,
    category: Number(eccn[0]),
    productGroup: eccn[1],
    heading: match[2],
    controls: sectionText(sections, /license requirements|reason for control/i),
    exceptions: sectionText(sections, /license exceptions|special conditions/i),
    items: sectionText(sections, /list of items controlled|^items\b/i),
    notes,
    definitions,
    crossReferences,
    sections,
    blocks,
    fullText,
    textHash: sha256(fullText),
    locator: `${cclSource.citation}, ECCN ${eccn}`,
    validationStatus: "parser_generated_unreviewed"
  };
}

function splitSections(blocks) {
  const sections = [];
  let current = { title: "Entry text", text: [], startBlockIndex: 0 };
  for (const block of blocks) {
    if (block.kind === "section_heading") {
      if (current.text.length) sections.push(section(current));
      current = { title: block.text, text: [], startBlockIndex: block.blockIndex + 1 };
    } else {
      current.text.push(block.text);
    }
  }
  if (current.text.length || current.title !== "Entry text") sections.push(section(current));
  return sections;
}

function section(value) {
  const text = value.text.join("\n");
  return { title: value.title, text, startBlockIndex: value.startBlockIndex, textHash: sha256(text) };
}

function isSectionHeading(text) {
  return /^(?:license requirements|list based license exceptions|special conditions for sta|list of items controlled|related controls|related definitions|items(?: paragraph)?|technical notes?)\b/i.test(text);
}

function blockKind(tag, text) {
  if (tag === "NOTE" || /^(?:technical\s+)?notes?\b/i.test(text)) return "note";
  if (isSectionHeading(text)) return "section_heading";
  if (/^(?:related\s+controls|see\s+also|cross[- ]reference)/i.test(text)) return "cross_reference";
  if (/^[a-z0-9]+(?:\.[a-z0-9]+)*[.)]\s+/i.test(text)) return "paragraph";
  return "text";
}

function paragraphLabel(text) {
  return text.match(/^([a-z0-9]+(?:\.[a-z0-9]+)*)[.)]\s+/i)?.[1];
}

function sectionText(sections, pattern) {
  return sections.filter((section) => pattern.test(section.title)).map((section) => section.text).join("\n");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/[\t\r\n ]+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values)];
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
