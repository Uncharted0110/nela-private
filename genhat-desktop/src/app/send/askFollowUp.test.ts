import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  __testResetAskFollowUpTurn,
  executeAskFollowUp,
  formatFollowUpIntoPrompt,
  normalizeAskFollowUpQuestions,
} from "./askFollowUp.js";
import { resolveFollowUp } from "../../stores/followUpStore.js";

describe("ask_followup host limits", () => {
  it("truncates to at most 3 questions", () => {
    const qs = normalizeAskFollowUpQuestions([
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
    ]);
    assert.equal(qs.length, 3);
    assert.equal(qs[2]?.prompt, "three");
  });

  it("skips a second ask_followup in the same turn", async () => {
    __testResetAskFollowUpTurn();
    const turnId = `test-turn-${Date.now()}`;

    const firstPromise = executeAskFollowUp(
      {
        reason: "Need a value",
        questions: [{ id: "v", prompt: "Value?", input_type: "text" }],
      },
      { turnId }
    );

    // Resolve the open modal asynchronously.
    queueMicrotask(() => {
      resolveFollowUp({
        status: "answered",
        answers: { v: "42" },
        attachedPaths: [],
      });
    });

    const first = await firstPromise;
    assert.equal(first.status, "answered");
    assert.equal(first.answers.v, "42");

    const second = await executeAskFollowUp(
      {
        reason: "Again?",
        questions: [{ prompt: "More?" }],
      },
      { turnId }
    );
    assert.equal(second.status, "skipped");
  });

  it("formats answers into the edit prompt", () => {
    const out = formatFollowUpIntoPrompt("fix revenue", {
      status: "answered",
      answers: { corrected_values: "4.2M" },
      attachedPaths: ["/tmp/a.png"],
      freeformNote: "use FY24",
    });
    assert.match(out, /4\.2M/);
    assert.match(out, /FY24/);
    assert.match(out, /a\.png/);
  });
});
