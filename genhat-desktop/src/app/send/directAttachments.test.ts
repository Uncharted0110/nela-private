import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIRECT_ATTACHMENT_SYSTEM,
  fileSearchEnabledForTurn,
  hasExplicitAttachments,
  overlayCloudAttachments,
  pluginForPrepared,
  preparedToContentParts,
  shouldSuppressFileSearch,
} from "./directAttachments.js";
import type { ChatMessage, PreparedCloudAttachment } from "../../types.js";
import { buildCloudChatTools } from "./cloudTools.js";

const pdf: PreparedCloudAttachment = {
  path: "/tmp/notes.pdf",
  name: "notes.pdf",
  mime: "application/pdf",
  sizeBytes: 1200,
  contentHash: "abc123",
  kind: "pdf",
  parser: "cloudflare-ai",
  destination: "cloud",
  dataUrl: "data:application/pdf;base64,QQ==",
};

describe("direct attachment routing", () => {
  it("suppresses file_search when the turn has explicit attachments", () => {
    assert.equal(
      fileSearchEnabledForTurn({
        fileIndexerEnabled: true,
        slashFileSearch: true,
        explicitAttachments: true,
      }),
      false
    );
    assert.equal(
      fileSearchEnabledForTurn({
        fileIndexerEnabled: true,
        slashFileSearch: false,
        explicitAttachments: false,
      }),
      true
    );
    const tools = buildCloudChatTools({
      webEnabled: true,
      fileSearchEnabled: false,
      chartEnabled: true,
    });
    assert.equal(
      tools.some((t) => t.function.name === "search_knowledge_base"),
      false
    );
    assert.equal(
      tools.some((t) => t.function.name === "web_search"),
      true
    );
  });

  it("keeps ambient library search when nothing is attached", () => {
    const tools = buildCloudChatTools({
      webEnabled: false,
      fileSearchEnabled: true,
    });
    assert.equal(
      tools.some((t) => t.function.name === "search_knowledge_base"),
      true
    );
  });

  it("builds mixed text/pdf parts and a file-parser plugin", () => {
    const parts = preparedToContentParts("Summarize", [pdf], []);
    assert.equal(parts[0]?.type, "text");
    assert.equal(parts[1]?.type, "file");
    assert.deepEqual(pluginForPrepared([pdf]), {
      id: "file-parser",
      pdf: { engine: "cloudflare-ai" },
    });
    assert.match(DIRECT_ATTACHMENT_SYSTEM, /do not call search_knowledge_base/i);
  });

  it("reuses PDF annotations on follow-up instead of resending the file", () => {
    const session: ChatMessage[] = [
      {
        role: "user",
        content: "Summarize",
        directDocuments: [
          {
            path: "/tmp/notes.pdf",
            name: "notes.pdf",
            contentHash: "abc123",
            kind: "pdf",
            parser: "cloudflare-ai",
          },
        ],
      },
      {
        role: "assistant",
        content: "It is a notes PDF.",
        fileAnnotations: [
          {
            type: "file",
            file: { hash: "abc123", name: "notes.pdf", content: [{ type: "text", text: "parsed" }] },
          },
        ],
      },
      { role: "user", content: "What is the title?" },
    ];
    const preparedByPath = new Map([[pdf.path, pdf]]);
    const out = overlayCloudAttachments({
      apiMessages: [
        { role: "system", content: "You are NELA." },
        { role: "user", content: "Summarize" },
        { role: "assistant", content: "It is a notes PDF." },
        { role: "user", content: "What is the title?" },
      ],
      sessionMessages: session,
      preparedByPath,
      warningsByPath: new Map(),
    });
    const firstUser = out[1];
    assert.equal(
      Array.isArray(firstUser?.content) &&
        firstUser.content.some((part) => part.type === "file"),
      false
    );
    assert.equal(out[2]?.annotations?.[0]?.file.hash, "abc123");
    assert.equal(hasExplicitAttachments(session[0]!), true);
    assert.equal(shouldSuppressFileSearch(session), true);
  });
});
