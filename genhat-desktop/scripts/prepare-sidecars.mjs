#!/usr/bin/env node
/**
 * Rebuild MCP artifact sidecars before every `tauri dev` / `tauri build`.
 *
 * Usage:
 *   node scripts/prepare-sidecars.mjs           # debug (for tauri dev)
 *   node scripts/prepare-sidecars.mjs --release # release (for tauri build)
 *
 * Always touches the sidecar sources so Cargo recompiles them from scratch
 * even when dependency fingerprints would otherwise skip the units.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";
const isWindows = process.platform === "win32";

const MCP_BINS = [
  "mcp-server-excel",
  "mcp-server-presentation",
  "mcp-server-html",
];

const MCP_SOURCES = [
  "src/bin/mcp_server_excel.rs",
  "src/bin/mcp_server_presentation.rs",
  "src/bin/mcp_server_html.rs",
];

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`);
}

function fail(msg) {
  console.error(`[prepare-sidecars] ${msg}`);
  process.exit(1);
}

function touch(filePath) {
  const now = new Date();
  try {
    fs.utimesSync(filePath, now, now);
  } catch {
    fs.closeSync(fs.openSync(filePath, "a"));
  }
}

function run(cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: isWindows,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(`command failed with exit code ${result.status}`);
  }
}

function main() {
  log(`rebuilding MCP sidecars (${profile})…`);

  for (const rel of MCP_SOURCES) {
    const abs = path.join(tauriDir, rel);
    if (!fs.existsSync(abs)) {
      fail(`missing sidecar source: ${rel}`);
    }
    touch(abs);
  }

  const cargoArgs = ["build", ...(release ? ["--release"] : [])];
  for (const bin of MCP_BINS) {
    cargoArgs.push("--bin", bin);
  }
  run("cargo", cargoArgs, tauriDir);

  const outDir = path.join(tauriDir, "target", profile);
  for (const bin of MCP_BINS) {
    const exe = isWindows ? `${bin}.exe` : bin;
    const built = path.join(outDir, exe);
    if (!fs.existsSync(built)) {
      fail(`expected sidecar binary missing after build: ${built}`);
    }
    log(`ok ${path.relative(root, built)}`);
  }

  log("done");
}

main();
