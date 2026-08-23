import type { ReactNode } from "react";
import { resolveSlashToken, type SlashCommandDef } from "../app/slashCommands";

export type SlashHighlightSegment =
  | { type: "text"; value: string }
  | { type: "command"; value: string; def: SlashCommandDef };

/** Split text into plain runs and recognized /command tokens. */
function segmentSlashCommands(text: string): SlashHighlightSegment[] {
  if (!text) return [];

  const segments: SlashHighlightSegment[] = [];
  // Match /token at start or after whitespace; token must resolve to a known command.
  const re = /(^|\s)(\/[a-zA-Z][a-zA-Z0-9_-]*)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const tokenWithSlash = match[2] ?? "";
    const token = tokenWithSlash.slice(1).toLowerCase();
    const def = resolveSlashToken(token);
    if (!def) continue;

    const start = match.index + prefix.length;
    if (start > last) {
      segments.push({ type: "text", value: text.slice(last, start) });
    }
    segments.push({ type: "command", value: tokenWithSlash, def });
    last = start + tokenWithSlash.length;
  }

  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }

  return segments;
}

function slashCommandChipClass(
  def: SlashCommandDef,
  variant: "overlay" | "bubble" = "bubble"
): string {
  const kind = def.artifact
    ? "artifact"
    : def.web
      ? "web"
      : def.rag
        ? "rag"
        : def.files
          ? "files"
          : "default";

  if (variant === "overlay") {
    // No horizontal padding — must keep character metrics aligned with the textarea.
    return [
      "slash-cmd-chip slash-cmd-chip--overlay",
      `slash-cmd-chip--${kind}`,
    ].join(" ");
  }

  return [
    "slash-cmd-chip slash-cmd-chip--bubble",
    `slash-cmd-chip--${kind}`,
  ].join(" ");
}

interface SlashHighlightedTextProps {
  text: string;
  /** `overlay` keeps metrics aligned for textarea mirrors; `bubble` uses padded pills. */
  variant?: "overlay" | "bubble";
  className?: string;
}

export function SlashHighlightedText({
  text,
  variant = "bubble",
  className,
}: SlashHighlightedTextProps): ReactNode {
  const segments = segmentSlashCommands(text);
  if (segments.length === 0) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          return <span key={i}>{seg.value}</span>;
        }
        return (
          <span key={i} className={slashCommandChipClass(seg.def, variant)}>
            {seg.value}
          </span>
        );
      })}
    </span>
  );
}
