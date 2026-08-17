import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationArtifactSource,
  resolveArtifactConversationSource,
} from "./conversationArtifactContext.js";
import type { ChatMessage } from "../../types.js";

const BANK_ANSWER = `Here's an accurate Q2 2026 comparative summary of the four major U.S. banks.

| Metric | Morgan Stanley | Goldman Sachs | JPMorgan Chase | Wells Fargo |
|---|---|---|---|---|
| Net revenue | $21.3B | $20.34B | $57.3B | $22.7B |
| Net income | $5.58B | $6.63B | $21.2B | $6.4B |

JPMorgan dwarfs the others on revenue and profit, while Goldman grew fastest.`;

const session: ChatMessage[] = [
  { role: "user", content: "Compare Q2 2026 financials of the big four banks" },
  { role: "assistant", content: BANK_ANSWER },
];

describe("conversation artifact source", () => {
  it("reuses the last substantive assistant answer", () => {
    const source = buildConversationArtifactSource(session);
    assert.ok(source, "expected a source");
    assert.equal(source!.hasTable, true);
    assert.match(source!.block, /RECENT CHAT CONTEXT/);
    assert.match(source!.block, /\$57\.3B/);
    assert.match(source!.block, /Compare Q2 2026 financials/);
    assert.match(source!.block, /do NOT invent replacement data/);
    assert.match(source!.block, /If it does not, ignore this entire block/);
  });

  it("provides candidate context for the planner to assess semantically", () => {
    assert.ok(
      resolveArtifactConversationSource(
        "Can you convert the same into an excel spreadsheet?",
        session
      )
    );
    assert.ok(
      resolveArtifactConversationSource(
        "Create a spreadsheet of the top 10 movies of 2026",
        session
      )
    );
  });

  it("skips artifact placeholders and short filler turns", () => {
    const messages: ChatMessage[] = [
      ...session,
      { role: "user", content: "make a deck" },
      {
        role: "assistant",
        content: "Generated your deck.",
        artifactPath: "/tmp/nela_artifacts/deck.html",
      },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "You're welcome!" },
    ];
    const source = buildConversationArtifactSource(messages);
    assert.ok(source);
    assert.match(source!.sourceAnswer, /Q2 2026 comparative summary/);
  });

  it("preserves table data when trimming to a small budget", () => {
    const padded: ChatMessage[] = [
      session[0]!,
      {
        role: "assistant",
        content: `${"prose ".repeat(800)}\n\n${BANK_ANSWER}`,
      },
    ];
    const source = buildConversationArtifactSource(padded, { maxChars: 2000 });
    assert.ok(source);
    assert.match(source!.block, /\$57\.3B/);
    assert.ok(source!.block.length <= 2400, "block should respect the budget");
  });

  it("returns null when there is no prior answer", () => {
    assert.equal(buildConversationArtifactSource([]), null);
    assert.equal(
      buildConversationArtifactSource([
        { role: "user", content: "hello there" },
      ]),
      null
    );
  });
});
