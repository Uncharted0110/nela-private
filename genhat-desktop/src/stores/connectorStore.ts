import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  connectorsAccountConnect,
  connectorsAddIndexedFolder,
  connectorsCreateFile,
  connectorsDisconnect,
  connectorsListChildren,
  connectorsListConnections,
  connectorsListIndexedRoots,
  connectorsListProviders,
  connectorsOauthPoll,
  connectorsOauthStart,
  connectorsSyncNow,
} from "../api";
import type {
  ConnectorConnection,
  ConnectorIndexedRoot,
  ConnectorProviderInfo,
  ConnectorRemoteEntry,
  ConnectorSyncReport,
} from "../types";
import { friendlyErrorFromUnknown } from "../app/friendlyError";
import { useGmailStore } from "./gmailStore";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Keep chat Gmail cards in sync when connection lifecycle goes through the catalog. */
function syncGmailStoreFromConnections(connections: ConnectorConnection[]) {
  const gmail = connections.find((c) => c.providerId === "gmail");
  useGmailStore.setState({
    connected: Boolean(gmail),
    email: gmail?.accountEmail ?? null,
    loading: false,
    error: null,
  });
}

type ConnectorStore = {
  providers: ConnectorProviderInfo[];
  connections: ConnectorConnection[];
  indexedRoots: ConnectorIndexedRoot[];
  busy: boolean;
  /** Provider id currently in an OAuth/connect flow (null when idle). */
  connectingProviderId: string | null;
  error: string | null;
  modalOpen: boolean;
  browserConnectionId: string | null;
  browserStack: Array<{ id: string | null; name: string }>;
  browserEntries: ConnectorRemoteEntry[];
  lastSyncReport: ConnectorSyncReport | null;

  openModal: () => void;
  closeModal: () => void;
  refresh: () => Promise<void>;
  connectProvider: (provider: string) => Promise<ConnectorConnection | null>;
  disconnect: (connectionId: string, wipeMirror?: boolean) => Promise<void>;
  openBrowser: (connectionId: string) => Promise<void>;
  closeBrowser: () => void;
  browseInto: (entry: ConnectorRemoteEntry) => Promise<void>;
  browseUp: () => Promise<void>;
  indexCurrentFolder: () => Promise<void>;
  syncNow: (connectionId: string) => Promise<void>;
  saveLocalFile: (
    connectionId: string,
    localPath: string,
    name: string,
    parentId?: string | null
  ) => Promise<void>;
};

/** Bumped to cancel in-flight cloud_broker poll loops when a new connect starts. */
let connectGeneration = 0;

function resolveConnectFlow(
  providers: ConnectorProviderInfo[],
  provider: string
): string {
  const info = providers.find((p) => p.id === provider);
  if (info?.connectFlow) return info.connectFlow;
  // Never assume cloud_broker — Gmail is desktop_pkce.
  if (provider === "gmail") return "desktop_pkce";
  if (provider === "local") return "none";
  return "cloud_broker";
}

function isStorageConnection(c: ConnectorConnection, providers: ConnectorProviderInfo[]) {
  const info = providers.find((p) => p.id === c.providerId);
  const caps = info?.capabilities ?? [];
  return caps.some((cap) => cap === "browse" || cap === "sync");
}

export const useConnectorStore = create<ConnectorStore>((set, get) => ({
  providers: [],
  connections: [],
  indexedRoots: [],
  busy: false,
  connectingProviderId: null,
  error: null,
  modalOpen: false,
  browserConnectionId: null,
  browserStack: [{ id: null, name: "My Drive" }],
  browserEntries: [],
  lastSyncReport: null,

  openModal: () => set({ modalOpen: true, error: null }),
  closeModal: () => set({ modalOpen: false }),

  refresh: async () => {
    try {
      const [providers, connections, indexedRoots] = await Promise.all([
        connectorsListProviders(),
        connectorsListConnections(),
        connectorsListIndexedRoots(),
      ]);
      syncGmailStoreFromConnections(connections);
      set({ providers, connections, indexedRoots, error: null });
    } catch (e) {
      set({ error: friendlyErrorFromUnknown(e) });
    }
  },

  connectProvider: async (provider) => {
    const generation = ++connectGeneration;
    set({ busy: true, connectingProviderId: provider, error: null });
    try {
      if (get().providers.length === 0) {
        await get().refresh();
      }
      const info = get().providers.find((p) => p.id === provider);
      const flow = resolveConnectFlow(get().providers, provider);

      if (flow === "desktop_pkce") {
        const connection = await connectorsAccountConnect(provider);
        if (generation !== connectGeneration) return null;
        await get().refresh();
        // Ensure UI flips even if list refresh races status read.
        if (
          connection &&
          !get().connections.some(
            (c) =>
              c.id === connection.id || c.providerId === connection.providerId
          )
        ) {
          const next = [connection, ...get().connections];
          syncGmailStoreFromConnections(next);
          set({ connections: next });
        }
        set({ busy: false, connectingProviderId: null });
        return connection;
      }

      if (flow === "none") {
        set({
          busy: false,
          connectingProviderId: null,
          error: `${info?.displayName ?? provider} does not need a sign-in.`,
        });
        return null;
      }

      // cloud_broker (Drive today)
      const start = await connectorsOauthStart(provider);
      if (generation !== connectGeneration) return null;
      await openUrl(start.authUrl);
      const intervalMs = Math.max(1, start.interval || 2) * 1000;
      const deadline = Date.now() + Math.max(30, start.expiresIn || 600) * 1000;
      while (Date.now() < deadline) {
        if (generation !== connectGeneration) return null;
        await sleep(intervalMs);
        if (generation !== connectGeneration) return null;
        const poll = await connectorsOauthPoll(start.sessionId, provider);
        if (poll.status === "approved") {
          if (generation !== connectGeneration) return null;
          await get().refresh();
          set({ busy: false, connectingProviderId: null });
          return poll.connection;
        }
        if (poll.status === "denied" || poll.status === "expired") {
          if (generation !== connectGeneration) return null;
          set({
            busy: false,
            connectingProviderId: null,
            error:
              poll.status === "denied"
                ? "Sign-in was denied."
                : "Sign-in expired. Please try again.",
          });
          return null;
        }
      }
      if (generation !== connectGeneration) return null;
      set({
        busy: false,
        connectingProviderId: null,
        error: "Sign-in timed out.",
      });
      return null;
    } catch (e) {
      if (generation !== connectGeneration) return null;
      set({
        busy: false,
        connectingProviderId: null,
        error: friendlyErrorFromUnknown(e),
      });
      return null;
    }
  },

  disconnect: async (connectionId, wipeMirror = true) => {
    set({ busy: true, error: null });
    try {
      await connectorsDisconnect(connectionId, wipeMirror);
      await get().refresh();
    } catch (e) {
      set({ error: friendlyErrorFromUnknown(e) });
    } finally {
      set({ busy: false });
    }
  },

  openBrowser: async (connectionId) => {
    const conn = get().connections.find((c) => c.id === connectionId);
    if (conn && !isStorageConnection(conn, get().providers)) {
      set({
        error: `${conn.displayName} does not browse folders — use it from chat or Settings.`,
      });
      return;
    }
    set({
      browserConnectionId: connectionId,
      browserStack: [{ id: null, name: "My Drive" }],
      browserEntries: [],
      error: null,
      busy: true,
    });
    try {
      const entries = await connectorsListChildren(connectionId, null);
      set({ browserEntries: entries, busy: false });
    } catch (e) {
      set({ busy: false, error: friendlyErrorFromUnknown(e) });
    }
  },

  closeBrowser: () => {
    set({
      browserConnectionId: null,
      browserEntries: [],
      browserStack: [{ id: null, name: "My Drive" }],
    });
  },

  browseInto: async (entry) => {
    const connectionId = get().browserConnectionId;
    if (!connectionId || entry.kind !== "folder") return;
    set({ busy: true, error: null });
    try {
      const entries = await connectorsListChildren(connectionId, entry.id);
      set((s) => ({
        browserStack: [...s.browserStack, { id: entry.id, name: entry.name }],
        browserEntries: entries,
        busy: false,
      }));
    } catch (e) {
      set({ busy: false, error: friendlyErrorFromUnknown(e) });
    }
  },

  browseUp: async () => {
    const { browserConnectionId, browserStack } = get();
    if (!browserConnectionId || browserStack.length <= 1) return;
    const next = browserStack.slice(0, -1);
    const parent = next[next.length - 1];
    set({ busy: true, error: null });
    try {
      const entries = await connectorsListChildren(
        browserConnectionId,
        parent.id
      );
      set({ browserStack: next, browserEntries: entries, busy: false });
    } catch (e) {
      set({ busy: false, error: friendlyErrorFromUnknown(e) });
    }
  },

  indexCurrentFolder: async () => {
    const { browserConnectionId, browserStack } = get();
    if (!browserConnectionId) return;
    const current = browserStack[browserStack.length - 1];
    set({ busy: true, error: null });
    try {
      const report = await connectorsAddIndexedFolder(
        browserConnectionId,
        current.id,
        current.name
      );
      set({ lastSyncReport: report, busy: false });
      await get().refresh();
      get().closeBrowser();
    } catch (e) {
      set({ busy: false, error: friendlyErrorFromUnknown(e) });
    }
  },

  syncNow: async (connectionId) => {
    set({ busy: true, error: null });
    try {
      const report = await connectorsSyncNow(connectionId);
      set({ lastSyncReport: report, busy: false });
      await get().refresh();
    } catch (e) {
      set({ busy: false, error: friendlyErrorFromUnknown(e) });
    }
  },

  saveLocalFile: async (connectionId, localPath, name, parentId) => {
    set({ busy: true, error: null });
    try {
      await connectorsCreateFile(connectionId, name, localPath, parentId);
      set({ busy: false });
      await get().refresh();
    } catch (e) {
      set({ busy: false, error: friendlyErrorFromUnknown(e) });
      throw e;
    }
  },
}));
