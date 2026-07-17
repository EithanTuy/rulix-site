import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const assetsDir = join(process.cwd(), "dist", "assets");
const assets = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
if (!assets.length) throw new Error("No production JavaScript assets found. Run npm run build first.");

const budgets = assets.map((name) => {
  const gzipBytes = gzipSync(readFileSync(join(assetsDir, name))).byteLength;
  const limitBytes = name.startsWith("index-") ? 150 * 1024 : 120 * 1024;
  return { name, gzipBytes, limitBytes };
});

const failures = budgets.filter((asset) => asset.gzipBytes > asset.limitBytes);
for (const asset of budgets.sort((left, right) => right.gzipBytes - left.gzipBytes)) {
  const size = (asset.gzipBytes / 1024).toFixed(1);
  const limit = (asset.limitBytes / 1024).toFixed(0);
  console.log(`${asset.name}: ${size} KiB gzip / ${limit} KiB budget`);
}
if (failures.length) {
  throw new Error(`Bundle budget exceeded: ${failures.map((asset) => asset.name).join(", ")}`);
}
