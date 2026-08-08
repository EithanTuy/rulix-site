import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CORPUS_BUILD_VERSION = "rulix-corpus-build/3";
const retrievedAt = new Date().toISOString();
const requestedAsOfDate = process.env.RULIX_CORPUS_AS_OF?.trim() || retrievedAt.slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOfDate)) {
  throw new Error("RULIX_CORPUS_AS_OF must be an ISO date (YYYY-MM-DD).");
}
const rawDir = path.resolve("corpus", "raw");
await mkdir(rawDir, { recursive: true });

const titleState = await loadTitleState();
if (titleState.importInProgress) {
  throw new Error("The eCFR import is in progress. Refusing to build a consequential corpus from a moving source.");
}

const sources = [
  earPart("ear-734", "734", "15 CFR Part 734 - Scope of the Export Administration Regulations"),
  earPart("ear-738", "738", "15 CFR Part 738 - Commerce Control List Overview and Country Chart"),
  earPart("ear-740", "740", "15 CFR Part 740 - License Exceptions"),
  earPart("ear-742", "742", "15 CFR Part 742 - Control Policy"),
  earPart("ear-744", "744", "15 CFR Part 744 - End-Use and End-User Controls"),
  earPart("ear-746", "746", "15 CFR Part 746 - Embargoes and Other Special Controls"),
  earPart("ear-748", "748", "15 CFR Part 748 - Applications and Documentation"),
  earPart("ear-762", "762", "15 CFR Part 762 - Recordkeeping"),
  earPart("ear-772", "772", "15 CFR Part 772 - Definitions of Terms"),
  {
    ...earPart("ear-774-supp-1", "774", "15 CFR Part 774 Supplement No. 1 - Commerce Control List"),
    citation: "15 CFR Part 774, Supplement No. 1",
    supplement: "1"
  },
  {
    ...earPart("ear-774-supp-2", "774", "15 CFR Part 774 Supplement No. 2 - General Technology and Software Notes"),
    citation: "15 CFR Part 774, Supplement No. 2",
    supplement: "2"
  },
  {
    ...earPart("ear-774-supp-4", "774", "15 CFR Part 774 Supplement No. 4 - CCL Order of Review"),
    citation: "15 CFR Part 774, Supplement No. 4",
    supplement: "4"
  },
  cfrPart("itar-120", "22", "120", "ITAR", "22 CFR Part 120 - Purpose and Definitions"),
  cfrPart("itar-121", "22", "121", "ITAR", "22 CFR Part 121 - United States Munitions List"),
  guidance(
    "bis-classify",
    "BIS - Classify Your Item",
    "BIS",
    "https://www.bis.gov/licensing/classify-your-item"
  ),
  guidance(
    "bis-encryption",
    "BIS - Encryption Controls",
    "BIS",
    "https://www.bis.gov/learn-support/encryption-controls"
  ),
  guidance(
    "ddtc-commodity-jurisdiction",
    "DDTC - Commodity Jurisdictions",
    "DDTC",
    "https://www.pmddtc.state.gov/ddtc_public?id=ddtc_kb_article_page&sys_id=7f67a5669791b6900083b3b0f053af2d"
  )
];

const responseCache = new Map();
const manifest = [];
for (const source of sources) {
  const dates = source.titleNumber
    ? await regulationDates(source.titleNumber, source.part)
    : {
        pointInTimeDate: requestedAsOfDate,
        currentThrough: requestedAsOfDate,
        amendmentDate: undefined
      };
  const apiUrl = source.titleNumber
    ? `https://www.ecfr.gov/api/versioner/v1/full/${dates.pointInTimeDate}/title-${source.titleNumber}.xml?part=${source.part}`
    : source.url;
  const response = await fetchBytes(apiUrl);
  const sha256 = digest(response.bytes);
  const extension = source.titleNumber ? "xml" : contentExtension(response.contentType);
  const relativeFileName = path.join(source.id, `${dates.pointInTimeDate}-${sha256}.${extension}`).replaceAll("\\", "/");
  const absoluteFileName = path.join(rawDir, ...relativeFileName.split("/"));
  await mkdir(path.dirname(absoluteFileName), { recursive: true });
  await writeImmutable(absoluteFileName, response.bytes, sha256);
  manifest.push({
    id: source.id,
    jurisdiction: source.authority === "ITAR" || source.authority === "DDTC" ? "ITAR" : "EAR",
    issuingAuthority: source.authority,
    title: source.title,
    citation: source.citation,
    canonicalUrl: source.url,
    apiUrl,
    part: source.part,
    supplement: source.supplement,
    rawFile: relativeFileName,
    mimeType: response.contentType,
    rawByteHash: sha256,
    byteLength: response.bytes.length,
    retrievedAt,
    amendmentDate: dates.amendmentDate,
    effectiveFrom: dates.amendmentDate,
    currentThrough: dates.currentThrough,
    pointInTimeDate: dates.pointInTimeDate,
    parserVersion: source.titleNumber ? "ecfr-versioner-xml/v3" : "official-guidance/v2",
    corpusBuildVersion: CORPUS_BUILD_VERSION,
    verificationStatus: "pending_review",
    transportStatus: "verified"
  });
}

const generatedManifest = {
  schemaVersion: "rulix.regulatory-corpus-manifest/v1",
  corpusBuildVersion: CORPUS_BUILD_VERSION,
  generatedAt: retrievedAt,
  requestedAsOfDate,
  currentThrough: earliestDate(manifest.map((source) => source.currentThrough)),
  reviewStatus: "pending_review",
  reviewRecord: null,
  sources: manifest
};
await writeFile(
  path.resolve("corpus", "manifest.generated.json"),
  `${JSON.stringify(generatedManifest, null, 2)}\n`,
  "utf8"
);

console.log(`Downloaded and hashed ${manifest.length} primary-source snapshots as of ${requestedAsOfDate}.`);
console.log("The generated corpus is pending review and cannot support a consequential classification yet.");

function earPart(id, part, title) {
  return cfrPart(id, "15", part, "EAR", title);
}

function cfrPart(id, titleNumber, part, authority, title) {
  return {
    id,
    title,
    authority,
    titleNumber,
    part,
    citation: `${titleNumber} CFR Part ${part}`,
    url: `https://www.ecfr.gov/current/title-${titleNumber}/part-${part}`
  };
}

function guidance(id, title, authority, url) {
  return { id, title, authority, citation: title, url };
}

async function loadTitleState() {
  const response = await fetchJson("https://www.ecfr.gov/api/versioner/v1/titles.json");
  const titles = new Map((response.titles ?? []).map((title) => [String(title.number), title]));
  return {
    titles,
    importInProgress: response.meta?.import_in_progress === true
  };
}

async function regulationDates(titleNumber, part) {
  const title = titleState.titles.get(String(titleNumber));
  if (!title?.up_to_date_as_of) throw new Error(`eCFR did not report a current-through date for title ${titleNumber}.`);
  const pointInTimeDate = requestedAsOfDate < title.up_to_date_as_of
    ? requestedAsOfDate
    : title.up_to_date_as_of;
  const response = await fetchJson(`https://www.ecfr.gov/api/versioner/v1/versions/title-${titleNumber}.json?part=${part}`);
  const amendmentDate = (response.content_versions ?? [])
    .filter((version) => String(version.part) === String(part) && version.date <= pointInTimeDate)
    .map((version) => version.date)
    .sort()
    .at(-1);
  return { pointInTimeDate, currentThrough: title.up_to_date_as_of, amendmentDate };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "RulixRegulatoryCorpus/3.0 (+https://rulix.cloud)" } });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchBytes(url) {
  if (responseCache.has(url)) return responseCache.get(url);
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "RulixRegulatoryCorpus/3.0 (+https://rulix.cloud)" }
  });
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  const result = {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase()
  };
  responseCache.set(url, result);
  return result;
}

async function writeImmutable(fileName, bytes, expectedHash) {
  try {
    const existing = await readFile(fileName);
    if (digest(existing) !== expectedHash) throw new Error(`Immutable source snapshot changed: ${fileName}`);
  } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") throw error;
    await writeFile(fileName, bytes, { flag: "wx" });
  }
}

function contentExtension(contentType) {
  if (contentType === "application/pdf") return "pdf";
  if (contentType.includes("json")) return "json";
  return "html";
}

function earliestDate(values) {
  return values.filter(Boolean).sort().at(0);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
