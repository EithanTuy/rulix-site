// Build the Lambda deployment bundle: esbuild-bundle the Express app into a
// single CJS handler and copy the built Vite client next to it. Output goes to
// `lambda-build/` which Terraform zips into the function package.
//
//   lambda-build/
//     handler.cjs    <- bundled server (export: handler)
//     dist/          <- built frontend (served by express.static at runtime)
//
// Run `npm run build` first so `dist/` exists.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.join(root, "lambda-build");
const distSrc = path.join(root, "dist");

if (!existsSync(distSrc)) {
  throw new Error("dist/ not found — run `npm run build` before build-lambda.");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "server", "lambda.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // .cjs so Node treats it as CommonJS even though package.json is type:module.
  outfile: path.join(outDir, "handler.cjs"),
  // The dist path is taken from RULIX_DIST_DIR at runtime, so import.meta.url is
  // never used in Lambda; define it to a valid placeholder to avoid the CJS warning.
  define: { "import.meta.url": JSON.stringify("file:///var/task/handler.cjs") },
  // Bundle AWS SDK v3 clients so the Lambda artifact owns its auth/storage dependencies.
  logLevel: "info"
});

cpSync(distSrc, path.join(outDir, "dist"), { recursive: true });

console.log("Lambda bundle ready at lambda-build/ (handler.cjs + dist/).");
