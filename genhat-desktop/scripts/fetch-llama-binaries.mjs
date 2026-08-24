#!/usr/bin/env node
/**
 * Download the latest official llama.cpp release binaries for the current
 * platform and stage them under src-tauri/bin/llama-{lin|mac|win}/.
 *
 * Mirrors asset naming and install layout from src-tauri/src/llama_updater/mod.rs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const binRoot = path.join(tauriDir, "bin");

const USER_AGENT = "GenHat-NELA-llama-updater";

function log(msg) {
  console.log(`[fetch-llama] ${msg}`);
}

function fail(msg) {
  console.error(`[fetch-llama] ${msg}`);
  process.exit(1);
}

function osFolder() {
  if (process.platform === "win32") return "llama-win";
  if (process.platform === "darwin") return "llama-mac";
  return "llama-lin";
}

function targetAssetName(tag) {
  const t = tag.trim();
  if (process.platform === "linux") {
    if (process.arch === "x64") return `llama-${t}-bin-ubuntu-x64.tar.gz`;
    if (process.arch === "arm64") return `llama-${t}-bin-ubuntu-arm64.tar.gz`;
  }
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return `llama-${t}-bin-macos-arm64.tar.gz`;
    if (process.arch === "x64") return `llama-${t}-bin-macos-x64.tar.gz`;
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") return `llama-${t}-bin-win-cpu-x64.zip`;
    if (process.arch === "arm64") return `llama-${t}-bin-win-cpu-arm64.zip`;
  }
  fail(`Unsupported platform: ${process.platform} ${process.arch}`);
}

function serverName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function cliName() {
  return process.platform === "win32" ? "llama-mtmd-cli.exe" : "llama-mtmd-cli";
}

function binariesPresent(dir) {
  return (
    fs.existsSync(path.join(dir, serverName())) &&
    fs.existsSync(path.join(dir, cliName()))
  );
}

function resolvePayloadRoot(extractDir) {
  if (binariesPresent(extractDir)) return extractDir;
  const nested = path.join(extractDir, osFolder());
  if (binariesPresent(nested)) return nested;
  return null;
}

function run(cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`command failed with exit code ${result.status}`);
}

function extractArchive(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (archivePath.endsWith(".tar.gz")) {
    run("tar", ["-xzf", archivePath, "-C", extractDir], root);
    return;
  }
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
        ],
        root,
      );
      return;
    }
    run("unzip", ["-q", archivePath, "-d", extractDir], root);
    return;
  }
  fail(`Unsupported archive format: ${archivePath}`);
}

function findSingleTopLevelDir(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 1) return path.join(rootDir, entries[0].name);
  if (entries.length === 0) return rootDir;
  fail(`Archive contained multiple top-level directories under ${rootDir}`);
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

function ensureExecutableTree(rootDir) {
  if (process.platform === "win32") return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      ensureExecutableTree(full);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if ([".so", ".dll", ".dylib", ".txt", ".md", ".json"].includes(ext)) continue;
    try {
      const mode = fs.statSync(full).mode;
      if ((mode & 0o111) === 0) fs.chmodSync(full, mode | 0o755);
    } catch {
      // best effort
    }
  }
}

async function fetchLatestBinaryRelease() {
  for (let page = 1; page <= 3; page += 1) {
    const url = `https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      fail(`GitHub release list failed with status ${response.status}`);
    }
    const releases = await response.json();
    if (!Array.isArray(releases) || releases.length === 0) break;

    for (const release of releases) {
      const tag = String(release.tag_name ?? "").trim();
      if (!tag) continue;
      const assetName = targetAssetName(tag);
      const asset = (release.assets ?? []).find((a) => a.name === assetName);
      if (asset?.browser_download_url) {
        return { tag, asset };
      }
    }

    if (releases.length < 100) break;
  }

  fail("No llama.cpp binary release found for this platform");
}

async function downloadFile(url, dest) {
  if (!url.startsWith("https://github.com/ggml-org/llama.cpp/releases/download/")) {
    fail(`Refusing untrusted download URL: ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    fail(`Download failed with status ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
}

async function main() {
  const { tag, asset } = await fetchLatestBinaryRelease();
  const destDir = path.join(binRoot, osFolder());
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genhat-llama-"));
  const archivePath = path.join(tmpRoot, asset.name);
  const extractDir = path.join(tmpRoot, "extract");

  log(`Downloading llama.cpp ${tag} (${asset.name})…`);
  await downloadFile(asset.browser_download_url, archivePath);

  log("Extracting archive…");
  extractArchive(archivePath, extractDir);
  const payloadParent = findSingleTopLevelDir(extractDir);
  const payloadRoot = resolvePayloadRoot(payloadParent);
  if (!payloadRoot) {
    fail(`Downloaded llama.cpp build ${tag} did not contain llama-server binaries`);
  }

  log(`Installing into ${path.relative(root, destDir)}…`);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  copyDirRecursive(payloadRoot, destDir);
  ensureExecutableTree(destDir);

  if (!binariesPresent(destDir)) {
    fail(`Installed llama.cpp build ${tag} is missing required binaries`);
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  log(`llama.cpp ${tag} ready at ${path.relative(root, destDir)}`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
