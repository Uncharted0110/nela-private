/**
 * Deterministic presentation plans from attached document text.
 * Used when the LLM fails so PPT generation still works — but the plan must
 * follow the user's requested outline, not dump raw file text into a shell.
 */

import { extractFieldValueRowsFromText } from "./spreadsheetPlan";
import { cleanPresentationTopic } from "./artifactPlanNormalize";

export interface PresentationDocumentFallback {
  userPrompt: string;
  ambientContent: string;
  theme?: string;
  targetSlideCount?: number;
}

const PITCH_BEATS: Array<{ re: RegExp; title: string; keywords: string[] }> = [
  {
    re: /business justific/i,
    title: "Business Justification",
    keywords: ["situation", "strategic", "business value", "opportunity", "quality engineering", "transformation"],
  },
  {
    re: /cost[- ]benefit|cost benefit|\bcba\b|\broi\b/i,
    title: "Cost–Benefit Analysis",
    keywords: ["cost", "benefit", "effort", "coverage", "manual", "reusable", "confidence", "automate"],
  },
  {
    re: /missing|gap|does not have|lack|limitation|hydrat/i,
    title: "Gaps vs Current Tooling",
    keywords: ["ptes", "hydrat", "script", "git", "vscode", "manual", "result", "analysis"],
  },
];

export function isLikelyDeckTemplate(
  path: string,
  body: string,
  userText: string
): boolean {
  const name = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (/template|theme|avocette/.test(name)) return true;
  const wantsTemplate = /\b(use|follow|match)\b[\s\S]{0,48}\btemplate\b/i.test(
    userText
  );
  if (wantsTemplate && /\.(html?|css)$/i.test(name)) return true;
  if (/\.(html?)$/i.test(name) && /class=["'][^"']*\bslide\b/i.test(body)) {
    return true;
  }
  return false;
}

export function looksLikeInstructionPrompt(topic: string): boolean {
  const t = topic.trim();
  if (t.length > 72) return true;
  return (
    /\b(includ(?:e|ing)|also|as well|highlight|use this|guidelines?)\b/i.test(t) ||
    /\binculdign\b|\bjustifcation\b/i.test(t)
  );
}

export function extractRequestedDeckOutline(prompt: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const beat of PITCH_BEATS) {
    if (!beat.re.test(prompt)) continue;
    const key = beat.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(beat.title);
  }
  return titles;
}

export function extractUserStatedFacts(prompt: string): string[] {
  const facts: string[] = [];
  const noHave = prompt.match(
    /ptes does not have ([^.]+?)(?:\.|$|scripts|no direct)/i
  );
  if (noHave?.[1]) {
    for (const part of noHave[1].split(/,| and /i)) {
      const item = part.replace(/\s+/g, " ").trim();
      if (item.length >= 8) facts.push(item);
    }
  }
  const copyPaste = prompt.match(
    /scripts have to copy[\s\S]{0,120}?saved/i
  );
  if (copyPaste) {
    facts.push(
      "Scripts must be copy-pasted from VS Code into PTES and then saved"
    );
  }
  if (/no direct pull from git/i.test(prompt)) {
    facts.push("No direct pull from Git for test scripts");
  }
  if (/data hydration/i.test(prompt)) {
    facts.push("PTES has no data hydration");
  }
  if (/test results analysis/i.test(prompt)) {
    facts.push("PTES lacks detailed test-results analysis");
  }
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = f.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferDeckTitle(prompt: string, ambient: string): string {
  const topic = cleanPresentationTopic(prompt);
  if (
    topic &&
    !/^(presentation|deck|slides?)$/i.test(topic) &&
    !looksLikeInstructionPrompt(topic)
  ) {
    return topic.slice(0, 80);
  }

  const fileMatch = ambient.match(/File:\s*"([^"]+)"/i);
  if (fileMatch?.[1] && !/template|theme/i.test(fileMatch[1])) {
    return fileMatch[1].replace(/\.[^.]+$/, "").slice(0, 80);
  }

  const firstLine = ambient
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length > 8 &&
        l.length < 90 &&
        !/^file:/i.test(l) &&
        !/^content:/i.test(l) &&
        !/^===/i.test(l) &&
        !/privacy statement/i.test(l) &&
        !/path:/i.test(l)
    );
  return (firstLine ?? "Pitch Deck").slice(0, 80);
}

function fieldBullets(rows: string[][]): string[] {
  return rows
    .map(([field, value]) => {
      const f = (field ?? "").trim();
      const v = (value ?? "").trim();
      if (!f || !v) return "";
      if (/^(file|path|content)$/i.test(f)) return "";
      return `${f}: ${v}`;
    })
    .filter(Boolean);
}

function isMetaLine(l: string): boolean {
  if (l.length < 12 || l.length > 220) return true;
  if (/^file:/i.test(l) || /^content:/i.test(l) || /^===/i.test(l)) return true;
  if (/\(Path:\s*\//i.test(l) || /^path:/i.test(l)) return true;
  if (/privacy statement|dentsu\.com/i.test(l)) return true;
  if (/^-- \d+ of \d+ --$/i.test(l)) return true;
  if (/page \d+ of \d+/i.test(l)) return true;
  if (/^\(Content could not be extracted/i.test(l)) return true;
  if (/^PART \d+ OF \d+/i.test(l)) return true;
  return false;
}

function extractContentLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => !isMetaLine(l));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
    if (unique.length >= 40) break;
  }
  return unique;
}

function pickLinesForBeat(lines: string[], keywords: string[], limit: number): string[] {
  const scored = lines
    .map((line) => {
      const lower = line.toLowerCase();
      const hits = keywords.filter((k) => lower.includes(k.toLowerCase())).length;
      return { line, hits };
    })
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of scored) {
    const key = row.line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.line);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build a usable presentation plan directly from document text + the user's brief.
 * Returns null only when there is essentially no extractable content.
 */
export function buildPresentationFallbackPlan(
  opts: PresentationDocumentFallback
): Record<string, unknown> | null {
  const ambient = opts.ambientContent?.trim() ?? "";
  if (!ambient || /\(Content could not be extracted/i.test(ambient)) {
    return null;
  }

  const title = inferDeckTitle(opts.userPrompt, ambient);
  const target = Math.max(4, Math.min(12, opts.targetSlideCount ?? 6));
  const theme = opts.theme || "corporate";
  const outline = extractRequestedDeckOutline(opts.userPrompt);
  const userFacts = extractUserStatedFacts(opts.userPrompt);
  const lines = extractContentLines(ambient);
  const extracted = extractFieldValueRowsFromText(ambient);
  const genericBullets =
    lines.length > 0
      ? lines
      : fieldBullets(extracted.rows).filter(Boolean);

  if (genericBullets.length === 0 && userFacts.length === 0) return null;

  const slides: Record<string, unknown>[] = [
    {
      title,
      layout: "TITLE",
      bullets: [
        outline.length
          ? `Pitch covering ${outline.join(", ").toLowerCase()}`
          : "Pitch grounded in the attached source and your brief",
      ],
    },
  ];

  const used = new Set<string>();
  const markUsed = (items: string[]) => {
    for (const item of items) used.add(item.toLowerCase());
  };

  if (outline.length > 0) {
    for (const beatTitle of outline) {
      const beat = PITCH_BEATS.find((b) => b.title === beatTitle);
      const fromDoc = beat
        ? pickLinesForBeat(genericBullets, beat.keywords, 4)
        : [];
      const fromUser =
        /gap|ptes|missing/i.test(beatTitle) ? userFacts.slice(0, 5) : [];
      const bullets = [...fromUser, ...fromDoc].filter((b, i, arr) => {
        const key = b.toLowerCase();
        return arr.findIndex((x) => x.toLowerCase() === key) === i;
      });
      if (bullets.length === 0) continue;
      markUsed(fromDoc);
      slides.push({
        title: beatTitle,
        layout: "BULLET",
        bullets: bullets.slice(0, 6),
      });
    }
  }

  const leftover = genericBullets.filter((l) => !used.has(l.toLowerCase()));
  const maxContent = Math.max(1, target - slides.length - 1);
  if (leftover.length > 0 && slides.length < target) {
    const perSlide = 4;
    const cap = outline.length > 0 ? Math.min(2, maxContent) : maxContent;
    for (let i = 0; i < Math.min(Math.ceil(leftover.length / perSlide), cap); i++) {
      slides.push({
        title: i === 0 ? "Current-state evidence" : `Evidence (${i + 1})`,
        layout: "BULLET",
        bullets: leftover.slice(i * perSlide, (i + 1) * perSlide),
      });
    }
  }

  if (slides.length < 2) return null;

  const closing = userFacts.slice(0, 3);
  slides.push({
    title: "Recommended next step",
    layout: "CENTERED",
    bullets:
      closing.length > 0
        ? closing
        : [
            `Build the remaining capability beyond today's tooling, using ${title} as the baseline.`,
          ],
  });

  const slug = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return {
    slides,
    theme,
    output_name: slug || "pitch_deck",
    _from_document_fallback: true,
  };
}
