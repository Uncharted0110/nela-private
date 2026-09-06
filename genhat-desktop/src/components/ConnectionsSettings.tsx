import { useEffect } from "react";
import { HardDrive, Loader2, Mail } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import { useGmailStore } from "../stores/gmailStore";

export default function ConnectionsSettings() {
  const profile = useAuthStore((s) => s.profile);
  const connected = useGmailStore((s) => s.connected);
  const email = useGmailStore((s) => s.email);
  const loading = useGmailStore((s) => s.loading);
  const error = useGmailStore((s) => s.error);
  const refresh = useGmailStore((s) => s.refresh);
  const connect = useGmailStore((s) => s.connect);
  const disconnect = useGmailStore((s) => s.disconnect);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[0.85rem] font-semibold text-txt">Connections</div>
        <div className="text-[0.78rem] text-txt-muted">
          Tap Connect, sign in with Google, and tap Allow. You confirm every
          email before it sends.
        </div>
        {profile?.authProvider === "google" && !connected ? (
          <div className="text-[0.78rem] text-txt-muted mt-1">
            You already signed into NELA with Google. Connect Gmail is a
            separate Allow step — the same account is fine.
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 py-1">
        <div className="flex items-start gap-2 min-w-0">
          <Mail size={16} className="mt-0.5 shrink-0 text-txt-muted" />
          <div className="min-w-0">
            <div className="text-[0.85rem] font-semibold text-txt">Gmail</div>
            <div className="text-[0.78rem] text-txt-muted truncate">
              {connected
                ? email
                  ? `Connected as ${email}`
                  : "Connected"
                : "Not connected"}
            </div>
          </div>
        </div>
        {connected ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-secondary hover:border-neon hover:text-neon disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            disabled={loading}
            onClick={() => void disconnect()}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-secondary hover:border-neon hover:text-neon disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            disabled={loading}
            onClick={() => void connect().catch(() => undefined)}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
            {loading ? "Opening Google…" : "Connect Gmail"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 py-1 opacity-70">
        <div className="flex items-start gap-2 min-w-0">
          <HardDrive size={16} className="mt-0.5 shrink-0 text-txt-muted" />
          <div className="min-w-0">
            <div className="text-[0.85rem] font-semibold text-txt">Google Drive</div>
            <div className="text-[0.78rem] text-txt-muted">
              {email
                ? `Will use ${email} when available`
                : "Coming soon — same Google account as Gmail"}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex items-center py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-muted cursor-not-allowed shrink-0"
          disabled
        >
          Coming soon
        </button>
      </div>

      {error ? (
        <p className="text-[0.78rem] text-red-400 m-0">{error}</p>
      ) : null}
    </div>
  );
}
