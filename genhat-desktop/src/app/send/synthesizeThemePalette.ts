/**
 * Ask the LLM for a contrast-safe theme palette (hex + gradient) for an HTML deck.
 * Prefers cloud; does not fall back to a cold local model.
 */

import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import type { FreeformThemePalette } from "./freeformHtmlThemeEdit";

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Compact deck style context for the palette model (no huge data-URIs). */
export function extractThemeContextFromHtml(html: string): string {
  const title =
    stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") ||
    stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n\n")
    .replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/g, "[image]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 7000);
  const hasLegacyOverride = /id=["']nela-theme-override["']/i.test(html);
  const hasSafety = /id=["']nela-theme-safety["']/i.test(html);
  return [
    title ? `DECK TITLE: ${title}` : "",
    hasLegacyOverride
      ? "NOTE: A legacy NELA theme override stylesheet is present."
      : "",
    hasSafety ? "NOTE: A NELA theme safety stylesheet is present." : "",
    styles ? `EXISTING CSS (truncated):\n${styles}` : "EXISTING CSS: (none found)",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.trim());
}

function isGradient(v: unknown): v is string {
  return typeof v === "string" && /gradient\s*\(/i.test(v) && v.length < 400;
}

export function parseThemePaletteJson(raw: string): FreeformThemePalette | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      const label =
        typeof obj.label === "string" && obj.label.trim()
          ? obj.label.trim().slice(0, 60)
          : "custom theme";
      const backgroundGradient = isGradient(obj.backgroundGradient)
        ? obj.backgroundGradient.trim()
        : isHex(obj.bg)
          ? `linear-gradient(145deg, ${obj.bg} 0%, ${obj.surface || obj.bg} 100%)`
          : null;
      const bg = isHex(obj.bg) ? obj.bg.trim() : null;
      const surface = isHex(obj.surface) ? obj.surface.trim() : bg;
      const text = isHex(obj.text) ? obj.text.trim() : null;
      const textMuted = isHex(obj.textMuted) ? obj.textMuted.trim() : text;
      const accent = isHex(obj.accent) ? obj.accent.trim() : null;
      const accentFrom = isHex(obj.accentFrom) ? obj.accentFrom.trim() : accent;
      const accentTo = isHex(obj.accentTo) ? obj.accentTo.trim() : accent;
      if (!backgroundGradient || !bg || !surface || !text || !textMuted || !accent || !accentFrom || !accentTo) {
        continue;
      }
      return {
        label,
        backgroundGradient,
        bg,
        surface,
        text,
        textMuted,
        accent,
        accentFrom,
        accentTo,
      };
    } catch {
      /* next */
    }
  }
  return null;
}

export type NelaThemeColorOps = {
  label: string;
  theme?: string;
  accent?: string;
  background?: string;
};

export function parseNelaThemeOpsJson(raw: string): NelaThemeColorOps | null {
  const palette = parseThemePaletteJson(raw);
  const trimmed = raw.trim();
  const brace = trimmed.match(/\{[\s\S]*\}/);
  let theme: string | undefined;
  try {
    const obj = JSON.parse(brace?.[0] ?? trimmed) as Record<string, unknown>;
    if (typeof obj.theme === "string" && obj.theme.trim()) {
      theme = obj.theme.trim().toLowerCase();
    }
  } catch {
    /* optional */
  }
  if (!palette && !theme) return null;
  return {
    label: palette?.label || theme || "theme",
    theme,
    accent: palette?.accent,
    background: palette?.bg,
  };
}

/**
 * LLM-synthesized freeform palette. Returns null if cloud/local generation fails.
 */
export function synthesizeThemePaletteFromLlm(options: {
  userRequest: string;
  html: string;
  onStatus?: (message: string) => void;
}): Promise<FreeformThemePalette | null> {
  const { userRequest, html, onStatus } = options;
  const context = extractThemeContextFromHtml(html);
  const useCloud = willRouteToCloud();
  onStatus?.(
    useCloud
      ? "Asking NELA Cloud for contrast-safe theme colors…"
      : "Generating contrast-safe theme colors…"
  );

  return new Promise((resolve) => {
    let content = "";
    let settled = false;
    const finish = (value: FreeformThemePalette | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    streamChatByMode({
      messages: [
        {
          role: "system",
          content:
            `You design accessible color themes for existing HTML slide decks.\n` +
            `Return ONLY JSON (no markdown):\n` +
            `{"label":"short name","backgroundGradient":"linear-gradient(...)","bg":"#hex","surface":"#hex","text":"#hex","textMuted":"#hex","accent":"#hex","accentFrom":"#hex","accentTo":"#hex"}\n` +
            `RULES:\n` +
            `- Match the user's requested look (e.g. bluish gradient).\n` +
            `- text and textMuted MUST be clearly readable on bg / backgroundGradient (high contrast).\n` +
            `- If the user asks to fix contrast, keep the background mood but pick readable text/accent hex codes.\n` +
            `- Use only #RGB / #RRGGBB hex for color fields.\n` +
            `- backgroundGradient must be a CSS linear-gradient or radial-gradient string.\n` +
            `- Do not copy illegible dark-on-dark or light-on-light pairs from the existing CSS.`,
        },
        {
          role: "user",
          content:
            `USER REQUEST:\n${userRequest.trim()}\n\n${context}\n\n` +
            `Return the JSON palette now.`,
        },
      ],
      intent: "quick_chat",
      containsFileContext: false,
      userConfirmedCloudContext: true,
      // Prefer cloud; if unavailable do not hang on a cold local model.
      disableLocalFallback: useCloud,
      disableThinking: true,
      response_format: useCloud ? { type: "json_object" } : undefined,
      generationOptions: { maxTokens: 420, temperature: 0.25 },
      onChunk: (chunk) => {
        content += chunk;
      },
      onThinking: () => {},
      onFinish: () => finish(parseThemePaletteJson(content)),
      onError: (err) => {
        console.warn("Theme palette synthesis failed:", err);
        finish(null);
      },
    });
  });
}

/** LLM theme + colors for NELA shell / PPTX surgical ops. */
export function synthesizeNelaThemeOpsFromLlm(options: {
  userRequest: string;
  currentTheme?: string;
  onStatus?: (message: string) => void;
}): Promise<NelaThemeColorOps | null> {
  const { userRequest, currentTheme, onStatus } = options;
  const useCloud = willRouteToCloud();
  onStatus?.(
    useCloud
      ? "Asking NELA Cloud for theme colors…"
      : "Generating theme colors…"
  );

  return new Promise((resolve) => {
    let content = "";
    let settled = false;
    const finish = (value: NelaThemeColorOps | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    streamChatByMode({
      messages: [
        {
          role: "system",
          content:
            `You pick presentation theme colors.\n` +
            `Return ONLY JSON:\n` +
            `{"label":"short name","theme":"midnight|corporate|sunset|minimal|academic|cyber|ocean|forest|lavender|neon|rose|slate","bg":"#hex","accent":"#hex","text":"#hex","textMuted":"#hex","surface":"#hex","accentFrom":"#hex","accentTo":"#hex","backgroundGradient":"linear-gradient(...)"}\n` +
            `text must contrast strongly with bg. Match the user request.`,
        },
        {
          role: "user",
          content:
            `USER REQUEST:\n${userRequest.trim()}\n` +
            (currentTheme ? `CURRENT THEME: ${currentTheme}\n` : "") +
            `Return JSON now.`,
        },
      ],
      intent: "quick_chat",
      containsFileContext: false,
      userConfirmedCloudContext: true,
      disableLocalFallback: useCloud,
      disableThinking: true,
      response_format: useCloud ? { type: "json_object" } : undefined,
      generationOptions: { maxTokens: 420, temperature: 0.25 },
      onChunk: (chunk) => {
        content += chunk;
      },
      onThinking: () => {},
      onFinish: () => finish(parseNelaThemeOpsJson(content)),
      onError: (err) => {
        console.warn("NELA theme ops synthesis failed:", err);
        finish(null);
      },
    });
  });
}
