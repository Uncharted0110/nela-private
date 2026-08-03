import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const roots = ["src", "src-tauri/src", "dist"];
const forbidden = [
  { label: "upstream API hostname", pattern: /openrouter\.ai/i },
  { label: "upstream key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/ },
  {
    label: "server-owned cloud model identifier",
    pattern:
      /\b(?:DeepSeek V4 (?:Flash|Pro)|Qwen 3\.(?:5 Flash|7 (?:Plus|Max))|GLM (?:4\.7 Flash|5\.2)|Kimi K2\.6)\b/i,
  },
];
const textExtensions = /\.(?:[cm]?[jt]sx?|rs|json|html|css|md|map)$/i;
const ignored = new Set(["node_modules", "target", ".git"]);
const failures = [];

async function scan(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (!ignored.has(entry)) await scan(join(path, entry));
    }
    return;
  }
  if (!textExtensions.test(path)) return;
  const content = await readFile(path, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) {
      failures.push(`${relative(root, path)}: ${rule.label}`);
    }
  }
}

for (const path of roots) await scan(join(root, path));

const localOnlyInferenceFiles = [
  "src/app/send/handleArtifactGeneration.ts",
  "src/app/send/handleArtifactEdit.ts",
  "src/app/send/handleSendMindmap.ts",
  "src/components/PodcastTab.tsx",
  "src/hooks/usePipelineStore.ts",
];
for (const relativePath of localOnlyInferenceFiles) {
  const path = join(root, relativePath);
  try {
    const content = await readFile(path, "utf8");
    if (/\bcloudRoute\b|\bcloud_assist_/i.test(content)) {
      failures.push(`${relativePath}: local-only surface references Cloud Assist routing`);
    }
  } catch {
    // Optional surfaces can move; the source scan above still enforces provider secrecy.
  }
}

if (failures.length) {
  console.error(`Cloud boundary check failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Cloud boundary check passed.");
