#!/usr/bin/env node
/**
 * Rebuild MCP artifact sidecars before every `tauri dev` / `tauri build`.
 * Also stages FileIndexer resources so Tauri can resolve them on every OS.
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

function ensureFileindexerResources() {
  const resourcesDir = path.join(tauriDir, "resources");
  const modelsDir = path.join(resourcesDir, "models", "fileindexer");
  fs.mkdirSync(modelsDir, { recursive: true });

  // Tauri requires resources/models/fileindexer to exist on every OS.
  const marker = path.join(modelsDir, ".nela-keep");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(
      marker,
      "Placeholder so Tauri can resolve resources/models/fileindexer.\nStage the MiniLM ONNX payload here for FileIndexer installs.\n"
    );
  }
  log(`ok resources/models/fileindexer`);

  const sidecarName = isWindows
    ? "fileindexer_sidecar.exe"
    : "fileindexer_sidecar";
  const sidecarDest = path.join(resourcesDir, sidecarName);

  const candidates = [
    process.env.FILEINDEXER_SIDECAR,
    path.join(tauriDir, "target", profile, sidecarName),
    path.join(tauriDir, "target", "release", sidecarName),
    path.join(tauriDir, "target", "debug", sidecarName),
    path.join(resourcesDir, sidecarName),
  ].filter(Boolean);

  // Windows-only fallback: keep using a checked-in .exe when present.
  if (isWindows) {
    candidates.push(path.join(resourcesDir, "fileindexer_sidecar.exe"));
  }

  if (fs.existsSync(sidecarDest)) {
    const st = fs.statSync(sidecarDest);
    if (st.size > 0) {
      // Don't treat a copied Windows PE as a valid Unix sidecar.
      if (!isWindows) {
        const fd = fs.openSync(sidecarDest, "r");
        const buf = Buffer.alloc(2);
        fs.readSync(fd, buf, 0, 2, 0);
        fs.closeSync(fd);
        if (buf[0] === 0x4d && buf[1] === 0x5a) {
          log(
            `warning: resources/${sidecarName} looks like a Windows PE — replacing with stub`
          );
        } else {
          log(`ok resources/${sidecarName}`);
          return;
        }
      } else {
        log(`ok resources/${sidecarName}`);
        return;
      }
    }
  }

  for (const src of candidates) {
    if (!src || src === sidecarDest || !fs.existsSync(src)) continue;
    const st = fs.statSync(src);
    if (!st.isFile() || st.size === 0) continue;
    if (!isWindows && src.endsWith(".exe")) continue;
    fs.copyFileSync(src, sidecarDest);
    if (!isWindows) {
      try {
        fs.chmodSync(sidecarDest, 0o755);
      } catch {
        /* ignore */
      }
    }
    log(`staged resources/${sidecarName} from ${path.relative(root, src)}`);
    return;
  }

  // Path must exist for Tauri resource resolution; stub keeps builds unblocked.
  const stub = isWindows
    ? "@echo off\r\necho FileIndexer sidecar not staged. See src-tauri/nsis/README.md\r\nexit /b 1\r\n"
    : "#!/bin/sh\necho \"FileIndexer sidecar not staged for this platform.\" >&2\nexit 1\n";
  fs.writeFileSync(sidecarDest, stub, { mode: 0o755 });
  log(
    `warning: resources/${sidecarName} missing — wrote stub so Tauri can resolve the path; stage a real binary for FileIndexer runtime`
  );
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

  ensureFileindexerResources();
  log("done");
}

main();
