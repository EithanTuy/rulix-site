import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const nodeModules = path.join(projectRoot, "node_modules");

const processes = [
  {
    name: "API",
    child: spawn(
      process.execPath,
      [
        path.join(nodeModules, "tsx", "dist", "cli.mjs"),
        path.join(projectRoot, "server", "index.ts")
      ],
      { cwd: projectRoot, stdio: "inherit" }
    )
  },
  {
    name: "Web",
    child: spawn(
      process.execPath,
      [
        path.join(nodeModules, "vite", "bin", "vite.js"),
        "--host",
        "127.0.0.1"
      ],
      { cwd: projectRoot, stdio: "inherit" }
    )
  }
];

let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of processes) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const { name, child } of processes) {
  child.on("error", (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      console.error(`${name} stopped (${signal}).`);
    } else if (code !== 0) {
      console.error(`${name} exited with code ${code}.`);
    }
    stopAll(code ?? 1);
  });
}

process.on("SIGINT", () => stopAll());
process.on("SIGTERM", () => stopAll());
