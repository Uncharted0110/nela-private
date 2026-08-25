#!/usr/bin/env node
/**
 * Sync release version into package.json, tauri.conf.json, and Cargo.toml.
 * Usage: node scripts/set-release-version.mjs [v]0.2.0
 * Or: RELEASE_VERSION=v0.2.0 node scripts/set-release-version.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const raw = (process.env.RELEASE_VERSION ?? process.argv[2] ?? '').trim();
if (!raw) {
  console.error('Usage: set-release-version.mjs <version>  (e.g. v0.2.0 or 0.2.0)');
  process.exit(1);
}

const version = raw.replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver version: ${JSON.stringify(raw)} → ${JSON.stringify(version)}`);
  process.exit(1);
}

function writeJson(rel, mutator) {
  const file = path.join(root, rel);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prev = data.version;
  mutator(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${rel}: ${prev} → ${data.version}`);
}

writeJson('package.json', (pkg) => {
  pkg.version = version;
});

writeJson('src-tauri/tauri.conf.json', (conf) => {
  conf.version = version;
});

const cargoPath = path.join(root, 'src-tauri/Cargo.toml');
const cargoPrev = fs.readFileSync(cargoPath, 'utf8');
let replaced = false;
const cargoNext = cargoPrev.replace(
  /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m,
  (_, prefix) => {
    replaced = true;
    return `${prefix}"${version}"`;
  },
);
if (!replaced) {
  console.error('Could not find [package] version in src-tauri/Cargo.toml');
  process.exit(1);
}
fs.writeFileSync(cargoPath, cargoNext);
console.log(`src-tauri/Cargo.toml: → ${version}`);
console.log(`Release version set to ${version}`);
