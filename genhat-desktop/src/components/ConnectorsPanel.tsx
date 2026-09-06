import { useEffect } from "react";
import {
  Cloud,
  FolderOpen,
  Loader2,
  RefreshCw,
  Unplug,
  ChevronRight,
  ArrowUp,
} from "lucide-react";
import { useConnectorStore } from "../stores/connectorStore";
import "./ConnectorsPanel.css";

export default function ConnectorsPanel() {
  const providers = useConnectorStore((s) => s.providers);
  const connections = useConnectorStore((s) => s.connections);
  const indexedRoots = useConnectorStore((s) => s.indexedRoots);
  const busy = useConnectorStore((s) => s.busy);
  const connectingProviderId = useConnectorStore((s) => s.connectingProviderId);
  const error = useConnectorStore((s) => s.error);
  const browserConnectionId = useConnectorStore((s) => s.browserConnectionId);
  const browserStack = useConnectorStore((s) => s.browserStack);
  const browserEntries = useConnectorStore((s) => s.browserEntries);
  const lastSyncReport = useConnectorStore((s) => s.lastSyncReport);
  const refresh = useConnectorStore((s) => s.refresh);
  const connectProvider = useConnectorStore((s) => s.connectProvider);
  const disconnect = useConnectorStore((s) => s.disconnect);
  const openBrowser = useConnectorStore((s) => s.openBrowser);
  const closeBrowser = useConnectorStore((s) => s.closeBrowser);
  const browseInto = useConnectorStore((s) => s.browseInto);
  const browseUp = useConnectorStore((s) => s.browseUp);
  const indexCurrentFolder = useConnectorStore((s) => s.indexCurrentFolder);
  const syncNow = useConnectorStore((s) => s.syncNow);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isStorageProvider = (p: (typeof providers)[number]) =>
    (p.capabilities ?? []).some((c) => c === "browse" || c === "sync");

  const isStorageConnection = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId);
    return p ? isStorageProvider(p) : providerId !== "gmail";
  };

  return (
    <div className="conn-panel">
      <div className="conn-header">
        <Cloud size={18} />
        <div>
          <h3>Connectors</h3>
          <p>
            Link cloud apps from the catalog. Storage connectors can sync a
            local mirror for <strong>Search my files</strong>. Gmail authorizes
            send from chat. File bytes stay on this device.
          </p>
        </div>
      </div>

      <div className="conn-providers">
        {(() => {
          const preferred = ["communication", "storage", "design", "accounting"];
          const cats = Array.from(
            new Set(providers.map((p) => p.category || "storage"))
          ).sort((a, b) => {
            const ai = preferred.indexOf(a);
            const bi = preferred.indexOf(b);
            if (ai === -1 && bi === -1) return a.localeCompare(b);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
          });
          return cats.map((category) => (
            <div key={category} className="conn-section">
              <h4>{category}</h4>
              {providers
                .filter((p) => (p.category || "storage") === category)
                .map((p) => {
                  const thisConnecting = connectingProviderId === p.id;
                  const conn = connections.find((c) => c.providerId === p.id);
                  const connected = Boolean(conn);
                  const storage = isStorageProvider(p);
                  return (
                    <div key={p.id} className="conn-provider-row">
                      <div>
                        <div className="conn-provider-name">{p.displayName}</div>
                        {connected ? (
                          <div className="conn-muted">
                            {conn?.accountEmail
                              ? `Connected as ${conn.accountEmail}`
                              : "Connected"}
                          </div>
                        ) : p.description ? (
                          <div className="conn-muted">{p.description}</div>
                        ) : null}
                        {p.comingSoon && !p.available && (
                          <div className="conn-muted">Coming soon</div>
                        )}
                      </div>
                      {!p.available ? (
                        <span className="conn-pill">Soon</span>
                      ) : connected ? (
                        <div className="conn-conn-actions">
                          {storage && conn ? (
                            <button
                              type="button"
                              className="conn-btn"
                              disabled={busy}
                              onClick={() => void openBrowser(conn.id)}
                              title="Pick folder to index"
                            >
                              <FolderOpen size={14} />
                              Browse
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="conn-btn danger"
                            disabled={busy}
                            onClick={() => void disconnect(conn?.id ?? p.id)}
                          >
                            <Unplug size={14} />
                            Disconnect
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="conn-btn primary"
                          disabled={busy}
                          onClick={() => void connectProvider(p.id)}
                        >
                          {thisConnecting ? (
                            <Loader2 size={14} className="conn-spin" />
                          ) : null}
                          Connect
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          ));
        })()}
      </div>

      {connections.length > 0 && (
        <div className="conn-section">
          <h4>Connected</h4>
          <ul className="conn-list">
            {connections.map((c) => {
              const storage = isStorageConnection(c.providerId);
              return (
                <li key={c.id}>
                  <div className="conn-conn-main">
                    <span className="conn-conn-title">
                      {c.displayName}
                      {c.accountEmail ? ` · ${c.accountEmail}` : ""}
                    </span>
                    <span className="conn-muted">
                      {c.status === "needsReauth"
                        ? "Needs reconnect"
                        : storage
                          ? c.remoteFolderName
                            ? `Folder: ${c.remoteFolderName}`
                            : "No folder indexed yet"
                          : "Ready"}
                    </span>
                  </div>
                  <div className="conn-conn-actions">
                    {storage ? (
                      <>
                        <button
                          type="button"
                          className="conn-btn"
                          disabled={busy}
                          onClick={() => void openBrowser(c.id)}
                          title="Pick folder to index"
                        >
                          <FolderOpen size={14} />
                          Browse
                        </button>
                        {c.mirrorRoot && (
                          <button
                            type="button"
                            className="conn-btn"
                            disabled={busy}
                            onClick={() => void syncNow(c.id)}
                          >
                            <RefreshCw size={14} />
                            Sync
                          </button>
                        )}
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="conn-btn danger"
                      disabled={busy}
                      onClick={() => void disconnect(c.id)}
                    >
                      <Unplug size={14} />
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {indexedRoots.length > 0 && (
        <div className="conn-section">
          <h4>Indexed cloud mirrors</h4>
          <ul className="conn-list compact">
            {indexedRoots.map((r) => (
              <li key={r.connectionId}>
                <span>{r.label}</span>
                <span className="conn-muted path">{r.mirrorRoot}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lastSyncReport && (
        <p className="conn-muted">
          Last sync: {lastSyncReport.fetched} new · {lastSyncReport.updated}{" "}
          updated · mirror {lastSyncReport.mirrorRoot}
        </p>
      )}

      {error && <p className="conn-error">{error}</p>}

      {browserConnectionId && (
        <div className="conn-browser">
          <div className="conn-browser-bar">
            <button
              type="button"
              className="conn-btn"
              disabled={busy || browserStack.length <= 1}
              onClick={() => void browseUp()}
            >
              <ArrowUp size={14} />
              Up
            </button>
            <div className="conn-crumbs">
              {browserStack.map((crumb, i) => (
                <span key={`${crumb.id}-${i}`}>
                  {i > 0 && <ChevronRight size={12} />}
                  {crumb.name}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="conn-btn primary"
              disabled={busy}
              onClick={() => void indexCurrentFolder()}
            >
              {busy ? <Loader2 size={14} className="conn-spin" /> : null}
              Sync &amp; index this folder
            </button>
            <button type="button" className="conn-btn" onClick={closeBrowser}>
              Close
            </button>
          </div>
          <ul className="conn-browser-list">
            {browserEntries.length === 0 ? (
              <li className="conn-muted">This folder is empty.</li>
            ) : (
              browserEntries.map((e) => (
                <li key={e.id}>
                  {e.kind === "folder" ? (
                    <button
                      type="button"
                      className="conn-link"
                      onClick={() => void browseInto(e)}
                    >
                      <FolderOpen size={14} /> {e.name}
                    </button>
                  ) : (
                    <span className="conn-file">{e.name}</span>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
