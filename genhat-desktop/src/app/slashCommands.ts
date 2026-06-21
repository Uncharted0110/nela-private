/**
 * Slash-command routing for the chat input.
 *
 * Users can prefix messages with one or more commands, e.g.
 *   `/web /excel Latest AI funding rounds by sector`
 * Commands are stripped from the prompt sent to the model but drive routing.
 */

export type SlashArtifactKind = "ppt" | "excel" | "html";

export interface SlashArtifactRoute {
  kind: SlashArtifactKind;
  tool: string;
  schemaId: string;
}

export interface SlashCommandDef {
  id: string;
  token: string;
  label: string;
  description: string;
  aliases: string[];
  artifact?: SlashArtifactRoute;
  web?: boolean;
  rag?: boolean;
  files?: boolean;
}

export interface ParsedSlashCommands {
  raw: string;
  /** Prompt with leading slash tokens removed. */
  cleanPrompt: string;
  /** Recognized slash tokens, e.g. ["/web", "/excel"]. */
  commands: string[];
  web: boolean;
  rag: boolean;
  files: boolean;
  artifact?: SlashArtifactRoute;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    id: "ppt",
    token: "ppt",
    label: "/ppt",
    description: "Generate a PowerPoint presentation",
    aliases: ["slides", "presentation", "deck", "slide"],
    artifact: {
      kind: "ppt",
      tool: "mcp-server-presentation",
      schemaId: "presentation_synthesis",
    },
  },
  {
    id: "excel",
    token: "excel",
    label: "/excel",
    description: "Generate an Excel spreadsheet",
    aliases: ["xlsx", "spreadsheet", "sheet", "csv"],
    artifact: {
      kind: "excel",
      tool: "mcp-server-excel",
      schemaId: "spreadsheet_synthesis",
    },
  },
  {
    id: "html",
    token: "html",
    label: "/html",
    description: "Generate an HTML page",
    aliases: ["webpage", "page", "website"],
    artifact: {
      kind: "html",
      tool: "mcp-server-html",
      schemaId: "html_synthesis",
    },
  },
  {
    id: "web",
    token: "web",
    label: "/web",
    description: "Search the web for context (combines with other commands)",
    aliases: ["internet", "online"],
    web: true,
  },
  {
    id: "rag",
    token: "rag",
    label: "/rag",
    description: "Search your ingested documents",
    aliases: ["docs", "documents", "kb", "library"],
    rag: true,
  },
  {
    id: "files",
    token: "files",
    label: "/files",
    description: "Search files on this device",
    aliases: ["file", "search", "find", "locate", "lookup"],
    files: true,
  },
];

const COMMAND_LOOKUP = new Map<string, SlashCommandDef>();
for (const cmd of SLASH_COMMANDS) {
  COMMAND_LOOKUP.set(cmd.token, cmd);
  for (const alias of cmd.aliases) {
    COMMAND_LOOKUP.set(alias, cmd);
  }
}

const ARTIFACT_FALLBACK_PROMPTS: Record<SlashArtifactKind, string> = {
  ppt: "Create a presentation on this topic.",
  excel: "Create a spreadsheet for this topic.",
  html: "Create an HTML page for this topic.",
};

export function resolveSlashToken(token: string): SlashCommandDef | undefined {
  return COMMAND_LOOKUP.get(token.toLowerCase());
}

/** Parse leading slash commands from a message. */
export function parseSlashCommands(text: string): ParsedSlashCommands {
  let remaining = text.trimStart();
  const commands: string[] = [];
  const flags = { web: false, rag: false, files: false };
  let artifact: SlashArtifactRoute | undefined;

  while (remaining.startsWith("/")) {
    const match = remaining.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*/);
    if (!match) break;

    const token = match[1].toLowerCase();
    const def = resolveSlashToken(token);
    if (!def) break;

    commands.push(`/${token}`);
    remaining = remaining.slice(match[0].length);

    if (def.web) flags.web = true;
    if (def.rag) flags.rag = true;
    if (def.files) flags.files = true;
    if (def.artifact) artifact = def.artifact;
  }

  const cleanPrompt = remaining.trim();

  return {
    raw: text,
    cleanPrompt,
    commands,
    ...flags,
    artifact,
  };
}

/** Prompt text to send after slash parsing (with artifact fallbacks). */
export function slashPromptForSend(parsed: ParsedSlashCommands): string {
  if (parsed.cleanPrompt) return parsed.cleanPrompt;
  if (parsed.artifact) return ARTIFACT_FALLBACK_PROMPTS[parsed.artifact.kind];
  return parsed.raw.trim();
}

export function filterSlashCommands(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.token.startsWith(q) ||
      cmd.label.toLowerCase().includes(q) ||
      cmd.aliases.some((alias) => alias.startsWith(q))
  );
}

/** Active slash token being typed immediately before the cursor, if any. */
export function activeSlashQuery(
  value: string,
  cursor: number
): { query: string; replaceStart: number; replaceEnd: number } | null {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
  if (!match) return null;
  const query = match[1] ?? "";
  const slashIndex = before.lastIndexOf("/");
  return {
    query,
    replaceStart: slashIndex,
    replaceEnd: cursor,
  };
}

export function insertSlashCommand(
  value: string,
  cursor: number,
  token: string
): { nextValue: string; nextCursor: number } {
  const active = activeSlashQuery(value, cursor);
  const insertion = `/${token} `;
  if (active) {
    const nextValue =
      value.slice(0, active.replaceStart) + insertion + value.slice(active.replaceEnd);
    return { nextValue, nextCursor: active.replaceStart + insertion.length };
  }
  const nextValue = value.slice(0, cursor) + insertion + value.slice(cursor);
  return { nextValue, nextCursor: cursor + insertion.length };
}
