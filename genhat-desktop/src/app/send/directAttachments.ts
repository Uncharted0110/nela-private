/**
 * Explicit chat attachments: mixed documents + images sent directly to local
 * extraction or OpenRouter. This is not retrieval / file_search.
 */

import type {
  ChatMessage,
  CloudChatContentPart,
  CloudChatMessage,
  CloudFileParserPlugin,
  DirectDocumentAttachment,
  FileAnnotation,
  PdfParserEngine,
  PreparedCloudAttachment,
} from "../../types";
import { Api } from "../../api";
import { sameAttachmentPath } from "../attachmentDisplay";

export const DIRECT_ATTACHMENT_SYSTEM = `The user attached named files to this turn. Those attachments are already present in the message as images, PDF files, or extracted document text. Treat them as the primary source. Do not call search_knowledge_base for these attached files.`;

export const CLOUD_ATTACHMENT_DISCLOSURE =
  "Files will be sent to NELA Cloud/OpenRouter for this conversation.";

export function hasExplicitAttachments(message: ChatMessage | null | undefined): boolean {
  if (!message) return false;
  return Boolean(
    message.visionImage?.path ||
      (message.directDocuments && message.directDocuments.length > 0)
  );
}

export function sessionHasExplicitAttachments(messages: ChatMessage[]): boolean {
  return messages.some(hasExplicitAttachments);
}

export function collectAttachmentPaths(messages: ChatMessage[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.visionImage?.path) paths.add(message.visionImage.path);
    for (const doc of message.directDocuments ?? []) {
      if (doc.path) paths.add(doc.path);
    }
  }
  return [...paths];
}

export function attachmentDestination(
  preferredMode: "local" | "cloud" | "auto"
): "local" | "cloud" {
  return preferredMode === "local" ? "local" : "cloud";
}

export function shouldSuppressFileSearch(messages: ChatMessage[]): boolean {
  return sessionHasExplicitAttachments(messages);
}

function textPart(text: string): CloudChatContentPart {
  return { type: "text", text };
}

function getByAttachmentPath<T>(
  byPath: Map<string, T>,
  path: string
): T | undefined {
  const direct = byPath.get(path);
  if (direct) return direct;
  for (const [key, value] of byPath) {
    if (sameAttachmentPath(key, path)) return value;
  }
  return undefined;
}

export function preparedToContentParts(
  prompt: string,
  prepared: PreparedCloudAttachment[],
  warnings: string[]
): CloudChatContentPart[] {
  const parts: CloudChatContentPart[] = [];
  const intro = [prompt.trim(), ...warnings].filter(Boolean).join("\n\n");
  if (intro) parts.push(textPart(intro));
  for (const file of prepared) {
    if (file.kind === "image" && file.dataUrl) {
      parts.push({
        type: "image_url",
        image_url: { url: file.dataUrl },
      });
    } else if (file.kind === "pdf" && file.dataUrl) {
      parts.push({
        type: "file",
        file: { filename: file.name, file_data: file.dataUrl },
      });
    } else if (file.extractedText) {
      parts.push(textPart(file.extractedText));
    }
  }
  return parts.length > 0 ? parts : [textPart(prompt)];
}

export function pluginForPrepared(
  prepared: PreparedCloudAttachment[]
): CloudFileParserPlugin | null {
  const pdfs = prepared.filter((file) => file.kind === "pdf" && file.dataUrl);
  if (pdfs.length === 0) return null;
  const engine: PdfParserEngine = pdfs.some((file) => file.parser === "mistral-ocr")
    ? "mistral-ocr"
    : pdfs.every((file) => file.parser === "native")
      ? "native"
      : "cloudflare-ai";
  return { id: "file-parser", pdf: { engine } };
}

function specsFromMessage(message: ChatMessage): Array<{
  path: string;
  pdfEngine?: PdfParserEngine | null;
}> {
  const specs: Array<{ path: string; pdfEngine?: PdfParserEngine | null }> = [];
  if (message.visionImage?.path) {
    specs.push({ path: message.visionImage.path });
  }
  for (const doc of message.directDocuments ?? []) {
    specs.push({
      path: doc.path,
      pdfEngine: doc.parser === "mistral-ocr" || doc.parser === "native" || doc.parser === "cloudflare-ai"
        ? doc.parser
        : undefined,
    });
  }
  return specs;
}

export async function prepareMessageAttachments(
  messages: ChatMessage[]
): Promise<{
  preparedByPath: Map<string, PreparedCloudAttachment>;
  warningsByPath: Map<string, string>;
}> {
  const specs = new Map<string, { path: string; pdfEngine?: PdfParserEngine | null }>();
  for (const message of messages) {
    for (const spec of specsFromMessage(message)) {
      specs.set(spec.path, spec);
    }
  }
  const preparedByPath = new Map<string, PreparedCloudAttachment>();
  const warningsByPath = new Map<string, string>();
  if (specs.size === 0) return { preparedByPath, warningsByPath };

  try {
    const prepared = await Api.prepareCloudAttachments([...specs.values()]);
    for (const file of prepared) {
      preparedByPath.set(file.path, file);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const path of specs.keys()) {
      warningsByPath.set(path, message);
    }
    return { preparedByPath, warningsByPath };
  }

  for (const message of messages) {
    for (const doc of message.directDocuments ?? []) {
      const prepared = getByAttachmentPath(preparedByPath, doc.path);
      if (!prepared) {
        warningsByPath.set(
          doc.path,
          `Couldn't read ${doc.name}. Reattach the file to continue.`
        );
        continue;
      }
      if (doc.contentHash && prepared.contentHash !== doc.contentHash) {
        warningsByPath.set(
          doc.path,
          `${doc.name} changed on disk since it was attached. Using the current file.`
        );
      }
    }
    const vision = message.visionImage;
    if (vision?.path && !getByAttachmentPath(preparedByPath, vision.path)) {
      warningsByPath.set(
        vision.path,
        `Couldn't read ${vision.name}. Reattach the image to continue.`
      );
    }
  }
  return { preparedByPath, warningsByPath };
}

function annotationsForAssistant(message: ChatMessage): FileAnnotation[] | undefined {
  return message.fileAnnotations && message.fileAnnotations.length > 0
    ? message.fileAnnotations
    : undefined;
}

/**
 * Overlay local attachment bytes onto compacted string messages at the cloud
 * boundary. Prior assistant PDF annotations are attached so parsers can be skipped.
 */
export function overlayCloudAttachments(input: {
  apiMessages: Array<{ role: string; content?: string | null }>;
  sessionMessages: ChatMessage[];
  preparedByPath: Map<string, PreparedCloudAttachment>;
  warningsByPath: Map<string, string>;
}): CloudChatMessage[] {
  const sessionUsers = input.sessionMessages.filter((m) => m.role === "user");
  const sessionAssistants = input.sessionMessages.filter((m) => m.role === "assistant");
  const userIndices: number[] = [];
  const assistantIndices: number[] = [];
  input.apiMessages.forEach((message, index) => {
    if (message.role === "user") userIndices.push(index);
    if (message.role === "assistant") assistantIndices.push(index);
  });

  const out: CloudChatMessage[] = input.apiMessages.map((message) => ({
    role: message.role as CloudChatMessage["role"],
    content: message.content ?? null,
  }));

  const annotatedHashes = new Set(
    sessionAssistants.flatMap((message) =>
      (message.fileAnnotations ?? []).map((ann) => ann.file.hash)
    )
  );

  const userOffset = sessionUsers.length - userIndices.length;
  userIndices.forEach((apiIndex, i) => {
    const prior = sessionUsers[userOffset + i];
    if (!prior || !hasExplicitAttachments(prior)) return;
    const prompt =
      typeof out[apiIndex]?.content === "string"
        ? String(out[apiIndex]?.content)
        : prior.content;
    const paths = [
      ...(prior.visionImage?.path ? [prior.visionImage.path] : []),
      ...(prior.directDocuments ?? []).map((d) => d.path),
    ];
    const prepared = paths
      .map((path) => getByAttachmentPath(input.preparedByPath, path))
      .filter((file): file is PreparedCloudAttachment => Boolean(file))
      .filter(
        (file) =>
          file.kind !== "pdf" ||
          file.parser === "native" ||
          !annotatedHashes.has(file.contentHash)
      );
    const warnings = paths
      .map((path) => getByAttachmentPath(input.warningsByPath, path))
      .filter((text): text is string => Boolean(text));
    out[apiIndex] = {
      ...out[apiIndex]!,
      content: preparedToContentParts(prompt, prepared, warnings),
    };
  });

  const assistantOffset = sessionAssistants.length - assistantIndices.length;
  assistantIndices.forEach((apiIndex, i) => {
    const prior = sessionAssistants[assistantOffset + i];
    const annotations = prior ? annotationsForAssistant(prior) : undefined;
    if (!annotations) return;
    out[apiIndex] = {
      ...out[apiIndex]!,
      annotations,
    };
  });

  return out;
}

export function stripPreparedBytes(
  prepared: PreparedCloudAttachment[]
): DirectDocumentAttachment[] {
  return prepared.map((file) => ({
    path: file.path,
    name: file.name,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
    kind: file.kind,
    parser: file.parser,
    destination: file.destination,
  }));
}

export function fileSearchEnabledForTurn(input: {
  fileIndexerEnabled: boolean;
  slashFileSearch: boolean;
  explicitAttachments: boolean;
}): boolean {
  if (input.explicitAttachments) return false;
  return input.fileIndexerEnabled || input.slashFileSearch;
}
