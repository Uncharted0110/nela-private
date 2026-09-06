import { useEffect } from "react";
import { HardDrive, Loader2, Mail, Plug } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import { useConnectorStore } from "../stores/connectorStore";

function iconFor(id: string, category?: string) {
  if (id === "gmail") return Mail;
  if (category === "storage" || id === "gdrive") return HardDrive;
  return Plug;
}

export default function ConnectionsSettings() {
  const profile = useAuthStore((s) => s.profile);
  const providers = useConnectorStore((s) => s.providers);
  const connections = useConnectorStore((s) => s.connections);
  const busy = useConnectorStore((s) => s.busy);
  const connectingProviderId = useConnectorStore((s) => s.connectingProviderId);
  const error = useConnectorStore((s) => s.error);
  const refresh = useConnectorStore((s) => s.refresh);
  const connectProvider = useConnectorStore((s) => s.connectProvider);
  const disconnect = useConnectorStore((s) => s.disconnect);
  const openModal = useConnectorStore((s) => s.openModal);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const settingsProviders = providers.filter(
    (p) => p.available || p.comingSoon
  );
  const gmailConnected = connections.some((c) => c.providerId === "gmail");

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[0.85rem] font-semibold text-txt">Connections</div>
        <div className="text-[0.78rem] text-txt-muted">
          Connectors are registered in the desktop catalog (
          <code className="text-[0.72rem]">connectors.toml</code>). Storage
          connectors can sync into Search my files; Gmail can send mail and
          read messages you approve in chat.
        </div>
        {profile?.authProvider === "google" && !gmailConnected ? (
          <div className="text-[0.78rem] text-txt-muted mt-1">
            You already signed into NELA with Google. Connect Gmail is a
            separate Allow step — the same account is fine.
          </div>
        ) : null}
        {gmailConnected ? (
          <div className="text-[0.78rem] text-txt-muted mt-1">
            If you connected Gmail before read support shipped, Disconnect and
            Connect again so Google grants inbox read.
          </div>
        ) : null}
      </div>

      {settingsProviders.map((p) => {
        const Icon = iconFor(p.id, p.category);
        const conn = connections.find((c) => c.providerId === p.id);
        const connected = Boolean(conn);
        const isStorage = (p.capabilities ?? []).some((c) =>
          ["browse", "sync"].includes(c)
        );
        const accountLabel = conn?.accountEmail
          ? `Connected as ${conn.accountEmail}`
          : conn?.remoteFolderName
            ? `Folder: ${conn.remoteFolderName}`
            : connected
              ? "Connected"
              : p.comingSoon
                ? "Coming soon"
                : "Not connected";

        const thisConnecting = connectingProviderId === p.id;

        return (
          <div
            key={p.id}
            className={`flex items-center justify-between gap-3 py-1 ${
              p.comingSoon && !p.available ? "opacity-70" : ""
            }`}
          >
            <div className="flex items-start gap-2 min-w-0">
              <Icon size={16} className="mt-0.5 shrink-0 text-txt-muted" />
              <div className="min-w-0">
                <div className="text-[0.85rem] font-semibold text-txt">
                  {p.displayName}
                </div>
                <div className="text-[0.78rem] text-txt-muted truncate">
                  {accountLabel}
                </div>
                {p.description ? (
                  <div className="text-[0.72rem] text-txt-muted mt-0.5">
                    {p.description}
                  </div>
                ) : null}
              </div>
            </div>
            {!p.available ? (
              <button
                type="button"
                className="inline-flex items-center py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-muted cursor-not-allowed shrink-0"
                disabled
              >
                Coming soon
              </button>
            ) : connected ? (
              <div className="flex items-center gap-1.5 shrink-0">
                {isStorage && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-secondary hover:border-neon hover:text-neon disabled:opacity-50"
                    disabled={busy}
                    onClick={() => openModal()}
                  >
                    Manage
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-secondary hover:border-neon hover:text-neon disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={busy}
                  onClick={() =>
                    void disconnect(conn?.id ?? p.id)
                  }
                >
                  {busy && !connectingProviderId ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg border border-glass-border bg-glass-bg text-txt-secondary hover:border-neon hover:text-neon disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    await connectProvider(p.id);
                    if (isStorage) openModal();
                  })();
                }}
              >
                {thisConnecting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Icon size={14} />
                )}
                {thisConnecting
                  ? "Opening Google…"
                  : `Connect ${p.displayName}`}
              </button>
            )}
          </div>
        );
      })}

      {error ? (
        <p className="text-[0.78rem] text-red-400 m-0">{error}</p>
      ) : null}
    </div>
  );
}
