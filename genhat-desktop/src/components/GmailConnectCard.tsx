import { Mail, X } from "lucide-react";
import { useGmailStore } from "../stores/gmailStore";
import { useGmailConnectPromptStore } from "../stores/gmailConnectPromptStore";
import "./GmailSendConfirmCard.css";

export default function GmailConnectCard() {
  const visible = useGmailConnectPromptStore((s) => s.visible);
  const hide = useGmailConnectPromptStore((s) => s.hide);
  const connected = useGmailStore((s) => s.connected);
  const loading = useGmailStore((s) => s.loading);
  const error = useGmailStore((s) => s.error);
  const connect = useGmailStore((s) => s.connect);

  if (!visible || connected) return null;

  const onConnect = () => {
    void connect()
      .then(() => hide())
      .catch(() => undefined);
  };

  return (
    <div className="gmail-confirm" role="dialog" aria-label="Connect Gmail">
      <div className="gmail-confirm__header">
        <div className="gmail-confirm__title">
          <Mail size={16} />
          <strong>Connect Gmail</strong>
        </div>
        <button
          type="button"
          className="gmail-confirm__icon-btn"
          onClick={hide}
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
      <p className="gmail-confirm__hint">
        Connect Gmail so NELA can send mail. You&apos;ll confirm every email
        before it goes out.
      </p>
      {error ? <p className="gmail-confirm__error">{error}</p> : null}
      <div className="gmail-confirm__actions">
        <button type="button" className="gmail-confirm__cancel" onClick={hide}>
          Not now
        </button>
        <button
          type="button"
          className="gmail-confirm__send"
          onClick={onConnect}
          disabled={loading}
        >
          {loading ? "Opening Google…" : "Connect Gmail"}
        </button>
      </div>
    </div>
  );
}
