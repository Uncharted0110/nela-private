import { Inbox, X } from "lucide-react";
import {
  resolveGmailReadConfirm,
  useGmailReadConfirmStore,
} from "../stores/gmailReadConfirmStore";
import "./GmailSendConfirmCard.css";

export default function GmailReadConfirmCard() {
  const pending = useGmailReadConfirmStore((s) => s.pending);
  if (!pending) return null;

  const { request } = pending;
  const confirm = () => {
    resolveGmailReadConfirm({ confirmed: true, request });
  };
  const cancel = () => {
    resolveGmailReadConfirm({ confirmed: false, reason: "user_cancelled" });
  };

  const detail =
    request.query && request.query !== "in:inbox"
      ? `Search: ${request.query}`
      : request.maxResults === 1
        ? "Latest message in your inbox"
        : `Up to ${request.maxResults} recent inbox messages`;

  return (
    <div className="gmail-confirm" role="dialog" aria-label="Allow Gmail read">
      <div className="gmail-confirm__header">
        <div className="gmail-confirm__title">
          <Inbox size={16} />
          <strong>Allow Gmail read?</strong>
        </div>
        <button
          type="button"
          className="gmail-confirm__icon-btn"
          onClick={cancel}
          aria-label="Cancel Gmail read"
        >
          <X size={16} />
        </button>
      </div>
      <p className="gmail-confirm__hint">
        {request.purpose}. NELA will fetch message content only for this request
        — nothing is stored in the cloud.
      </p>
      <p className="gmail-confirm__hint" style={{ marginTop: 0 }}>
        {detail}
      </p>
      <div className="gmail-confirm__actions">
        <button type="button" className="gmail-confirm__cancel" onClick={cancel}>
          Deny
        </button>
        <button type="button" className="gmail-confirm__send" onClick={confirm}>
          Allow once
        </button>
      </div>
    </div>
  );
}
