#!/usr/bin/env node
/**
 * Rebuild MCP artifact sidecars + FileIndexer sidecar before every `tauri dev` / `tauri build`.
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
const fileIndexerDir = path.join(tauriDir, "crates/file-indexer");
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

function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    fail("failed to detect rustc host triple");
  }
  const match = result.stdout.match(/^host: (.+)$/m);
  if (!match) {
    fail("could not parse rustc host triple");
  }
  return match[1].trim();
}

function stageExternalBin(binName, builtPath) {
  const triple = hostTriple();
  const ext = isWindows ? ".exe" : "";
  const stagedName = `${binName}-${triple}${ext}`;
  const binDir = path.join(tauriDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stagedPath = path.join(binDir, stagedName);
  fs.copyFileSync(builtPath, stagedPath);
  log(`ok ${path.relative(root, stagedPath)}`);
}

function main() {
  log(`rebuilding FileIndexer sidecar (${profile})…`);
  touch(path.join(fileIndexerDir, "src/bin/fileindexer_sidecar.rs"));
  run(
    "cargo",
    [
      "build",
      "--manifest-path",
      path.join(fileIndexerDir, "Cargo.toml"),
      ...(release ? ["--release"] : []),
      "--bin",
      "fileindexer_sidecar",
    ],
    tauriDir,
  );

  const fiExe = isWindows ? "fileindexer_sidecar.exe" : "fileindexer_sidecar";
  const fiBuilt = path.join(fileIndexerDir, "target", profile, fiExe);
  if (!fs.existsSync(fiBuilt)) {
    fail(`expected FileIndexer sidecar missing after build: ${fiBuilt}`);
  }
  stageExternalBin("fileindexer_sidecar", fiBuilt);

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
