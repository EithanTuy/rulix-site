import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const sources = [
  {
    id: "itar-120",
    url: "https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120"
  },
  {
    id: "itar-121",
    url: "https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-121"
  },
  {
    id: "ear-734-3",
    url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.3"
  },
  {
    id: "ear-774-supp-4",
    url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774"
  },
  {
    id: "bis-classify",
    url: "https://www.bis.gov/licensing/classify-your-item"
  },
  {
    id: "ita-eccn",
    url: "https://www.trade.gov/how-do-i-determine-my-export-control-classification-number-eccn"
  }
];

const rawDir = path.resolve("corpus", "raw");
await mkdir(rawDir, { recursive: true });

const manifest = [];

for (const source of sources) {
  const response = await fetch(source.url, {
    headers: { "user-agent": "Rulix-ECCN prototype corpus downloader" }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${source.id}: ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  const sha256 = createHash("sha256").update(body).digest("hex");
  const fileName = `${source.id}.html`;
  await writeFile(path.join(rawDir, fileName), body, "utf8");
  manifest.push({
    ...source,
    fileName,
    sha256,
    bytes: Buffer.byteLength(body),
    downloadedAt: new Date().toISOString()
  });
}

await writeFile(
  path.resolve("corpus", "manifest.generated.json"),
  `${JSON.stringify({ sources: manifest }, null, 2)}\n`,
  "utf8"
);

console.log(`Downloaded ${manifest.length} official corpus documents to ${rawDir}`);
