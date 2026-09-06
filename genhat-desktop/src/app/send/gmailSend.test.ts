import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGmailSendArgs, parseRecipientList } from "./gmailSend.js";
import { looksLikeEmailRequest } from "./gmailConnectIntent.js";

describe("parseRecipientList", () => {
  it("splits comma lists and dedupes", () => {
    assert.deepEqual(parseRecipientList("a@b.com, c@d.com"), ["a@b.com", "c@d.com"]);
    assert.deepEqual(parseRecipientList(["A@b.com", "a@b.com"]), ["A@b.com"]);
  });

  it("splits spoken lists", () => {
    assert.deepEqual(parseRecipientList("a@b.com and c@d.com"), ["a@b.com", "c@d.com"]);
    assert.deepEqual(parseRecipientList(["a@b.com", "c@d.com; e@f.com"]), [
      "a@b.com",
      "c@d.com",
      "e@f.com",
    ]);
  });
});

describe("parseGmailSendArgs", () => {
  it("accepts a complete draft", () => {
    const parsed = parseGmailSendArgs({
      to: "priya@example.com",
      subject: "Running late",
      body: "I will be 10 minutes late.",
    });
    assert.ok(!("error" in parsed));
    if ("error" in parsed) return;
    assert.deepEqual(parsed.to, ["priya@example.com"]);
    assert.equal(parsed.subject, "Running late");
  });

  it("rejects missing recipients and subject", () => {
    assert.ok("error" in parseGmailSendArgs({ subject: "Hi", body: "Hello" }));
    assert.ok(
      "error" in
        parseGmailSendArgs({ to: "priya@example.com", subject: "", body: "Hello" })
    );
  });
});

describe("looksLikeEmailRequest", () => {
  it("detects send-mail phrasing", () => {
    assert.equal(looksLikeEmailRequest("Email Priya that I will be late"), true);
    assert.equal(looksLikeEmailRequest("write a mail to finance"), true);
    assert.equal(looksLikeEmailRequest("What is the capital of France?"), false);
  });
});
