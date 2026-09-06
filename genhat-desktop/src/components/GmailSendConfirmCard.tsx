import { useEffect, useState } from "react";
import { Mail, X } from "lucide-react";
import {
  resolveGmailSendConfirm,
  useGmailSendConfirmStore,
  type GmailDraft,
} from "../stores/gmailSendConfirmStore";
import { extractEmails } from "../app/send/gmailSend";
import "./GmailSendConfirmCard.css";

function listToInput(list: string[]): string {
  return list.join(", ");
}

function inputToList(value: string): string[] {
  return extractEmails(value);
}

export default function GmailSendConfirmCard() {
  const pending = useGmailSendConfirmStore((s) => s.pending);
  const [draft, setDraft] = useState<GmailDraft | null>(null);
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [initId, setInitId] = useState<string | null>(null);

  const requestId = pending?.requestId ?? null;
  if (pending && requestId !== initId) {
    setInitId(requestId);
    setDraft(pending.draft);
    setToInput(listToInput(pending.draft.to));
    setCcInput(listToInput(pending.draft.cc));
  }

  useEffect(() => {
    if (!pending) {
      setDraft(null);
      setInitId(null);
    }
  }, [pending]);

  if (!pending || !draft) return null;

  const update = (patch: Partial<GmailDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const confirm = () => {
    const to = inputToList(toInput);
    if (!to.length || !draft.subject.trim() || !draft.body.trim()) return;
    resolveGmailSendConfirm({
      confirmed: true,
      draft: {
        ...draft,
        to,
        cc: inputToList(ccInput),
        subject: draft.subject.trim(),
      },
    });
  };

  const cancel = () => {
    resolveGmailSendConfirm({ confirmed: false, reason: "user_cancelled" });
  };

  const canSend =
    inputToList(toInput).length > 0 &&
    draft.subject.trim().length > 0 &&
    draft.body.trim().length > 0;

  return (
    <div className="gmail-confirm" role="dialog" aria-label="Confirm email">
      <div className="gmail-confirm__header">
        <div className="gmail-confirm__title">
          <Mail size={16} />
          <strong>Send this email?</strong>
        </div>
        <button
          type="button"
          className="gmail-confirm__icon-btn"
          onClick={cancel}
          aria-label="Cancel email"
        >
          <X size={16} />
        </button>
      </div>
      <p className="gmail-confirm__hint">
        Review and edit before sending. Separate addresses with commas.
        Nothing is sent until you confirm.
      </p>
      <label className="gmail-confirm__field">
        <span>To</span>
        <input
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
          autoComplete="off"
          placeholder="one@email.com, two@email.com"
        />
      </label>
      <label className="gmail-confirm__field">
        <span>Cc</span>
        <input
          value={ccInput}
          onChange={(e) => setCcInput(e.target.value)}
          autoComplete="off"
          placeholder="optional"
        />
      </label>
      <label className="gmail-confirm__field">
        <span>Subject</span>
        <input
          value={draft.subject}
          onChange={(e) => update({ subject: e.target.value })}
          autoComplete="off"
        />
      </label>
      <label className="gmail-confirm__field">
        <span>Body</span>
        <textarea
          value={draft.body}
          onChange={(e) => update({ body: e.target.value })}
          rows={8}
        />
      </label>
      <div className="gmail-confirm__nela-footer">
        <img src="/logo-dark.png" alt="NELA" />
        <em>This message was sent using nela</em>
      </div>
      <div className="gmail-confirm__actions">
        <button type="button" className="gmail-confirm__cancel" onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className="gmail-confirm__send"
          onClick={confirm}
          disabled={!canSend}
        >
          Send
        </button>
      </div>
    </div>
  );
}
