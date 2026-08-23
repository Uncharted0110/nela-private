import { useCallback, useEffect, useMemo, useState } from "react";
import { friendlyErrorFromUnknown } from "../app/friendlyError";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  FileText,
  Folder,
  HardDrive,
  Home,
  Monitor,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Api } from "../api";
import type { FsEntry } from "../types";
import {
  resolveRagSourcePicker,
  useRagSourcePickerStore,
} from "../stores/ragSourcePickerStore";
import "./RagSourcePickerModal.css";

function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function isStrictDescendant(childPath: string, ancestorPath: string): boolean {
  const child = normalizeForCompare(childPath);
  const anc = normalizeForCompare(ancestorPath).replace(/\/+$/, "");
  if (!anc) return false;
  if (child === anc) return false;
  return child.startsWith(`${anc}/`);
}

function parentDir(p: string): string | null {
  const normalized = p.replace(/[/\\]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (idx <= 0) {
    // Windows drive root like C:
    if (/^[a-zA-Z]:$/.test(normalized)) return `${normalized}\\`;
    return null;
  }
  // Keep drive root as C:\
  const parent = normalized.slice(0, idx);
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`;
  return parent || null;
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatMtime(epochSec: number): string {
  if (!epochSec) return "—";
  try {
    return new Date(epochSec * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function isDriveRoot(name: string, path: string): boolean {
  return /^[a-zA-Z]:\\?$/.test(name.trim()) || /^[a-zA-Z]:\\?$/.test(path.trim()) || name === "/";
}

function sidebarIcon(name: string) {
  if (isDriveRoot(name, name)) return <HardDrive size={15} />;
  if (name === "Home") return <Home size={15} />;
  if (name === "Desktop") return <Monitor size={15} />;
  return <Folder size={15} />;
}

export default function RagSourcePickerModal() {
  const isOpen = useRagSourcePickerStore((s) => s.open);
  const allowedExtensions = useRagSourcePickerStore((s) => s.allowedExtensions);
  const foldersOnly = useRagSourcePickerStore((s) => s.foldersOnly);
  const filesOnly = useRagSourcePickerStore((s) => s.filesOnly);
  const title = useRagSourcePickerStore((s) => s.title);
  const confirmLabel = useRagSourcePickerStore((s) => s.confirmLabel);

  const [roots, setRoots] = useState<FsEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);

  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(() => new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());
  const [summaryOpen, setSummaryOpen] = useState(false);

  const systemRoots = useMemo(
    () => roots.filter((r) => !isDriveRoot(r.name, r.path)),
    [roots],
  );
  const volumeRoots = useMemo(
    () => roots.filter((r) => isDriveRoot(r.name, r.path)),
    [roots],
  );
  const homeRoot = useMemo(
    () => roots.find((r) => r.name === "Home")?.path ?? null,
    [roots],
  );

  const isInsideHome = useCallback(
    (dirPath: string) => {
      if (!homeRoot) return true;
      const home = normalizeForCompare(homeRoot).replace(/\/+$/, "");
      const dest = normalizeForCompare(dirPath).replace(/\/+$/, "");
      return dest === home || dest.startsWith(`${home}/`);
    },
    [homeRoot],
  );

  const hasSelection = foldersOnly
    ? selectedFolders.size > 0
    : filesOnly
      ? selectedFiles.size > 0
      : selectedFolders.size + selectedFiles.size > 0;

  const isCoveredBySelectedFolder = useCallback(
    (nodePath: string) => {
      for (const folder of selectedFolders) {
        if (isStrictDescendant(nodePath, folder)) return true;
      }
      return false;
    },
    [selectedFolders],
  );

  const loadDir = useCallback(
    async (dirPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await Api.listFsEntries(dirPath, allowedExtensions);
        setEntries(list);
        setCurrentPath(dirPath);
      } catch (e) {
        console.error("listFsEntries failed:", e);
        setEntries([]);
        setError(friendlyErrorFromUnknown(e));
      } finally {
        setLoading(false);
      }
    },
    [allowedExtensions],
  );

  const navigateTo = useCallback(
    async (dirPath: string, opts?: { pushHistory?: boolean }) => {
      if (!dirPath) return;
      if (foldersOnly && homeRoot && !isInsideHome(dirPath)) {
        setError("Only folders inside your home directory can be selected.");
        return;
      }
      const push = opts?.pushHistory !== false;
      if (push && currentPath && normalizeForCompare(currentPath) !== normalizeForCompare(dirPath)) {
        setHistory((prev) => [...prev, currentPath]);
        setFuture([]);
      }
      await loadDir(dirPath);
    },
    [currentPath, foldersOnly, homeRoot, isInsideHome, loadDir],
  );

  useEffect(() => {
    if (!isOpen) return;

    setSelectedFolders(new Set());
    setSelectedFiles(new Set());
    setSummaryOpen(false);
    setHistory([]);
    setFuture([]);
    setQuery("");
    setError(null);
    setEntries([]);
    setCurrentPath("");
    setLoading(true);

    void Api.listFsRoots()
      .then(async (r) => {
        setRoots(r);
        const start =
          (foldersOnly ? r.find((x) => x.name === "Home") : null) ??
          r.find((x) => x.name === "Documents") ??
          r.find((x) => x.name === "Home") ??
          r[0];
        if (start) await loadDir(start.path);
        else setLoading(false);
      })
      .catch((e) => {
        console.error("listFsRoots failed:", e);
        setError(friendlyErrorFromUnknown(e));
        setLoading(false);
      });
  }, [isOpen, loadDir, foldersOnly]);

  const goBack = async () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    if (currentPath) setFuture((f) => [currentPath, ...f]);
    await loadDir(prev);
  };

  const goForward = async () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    if (currentPath) setHistory((h) => [...h, currentPath]);
    await loadDir(next);
  };

  const goUp = async () => {
    if (!currentPath) return;
    const parent = parentDir(currentPath);
    if (!parent || normalizeForCompare(parent) === normalizeForCompare(currentPath)) return;
    if (foldersOnly && homeRoot && !isInsideHome(parent)) return;
    await navigateTo(parent);
  };

  const refresh = async () => {
    if (!currentPath) return;
    // force reload cache
    setEntries([]);
    await loadDir(currentPath);
  };

  const onToggleFolder = (folderPath: string) => {
    const currentlySelected = selectedFolders.has(folderPath);
    const covered = isCoveredBySelectedFolder(folderPath);
    if (!currentlySelected && covered) return;

    if (currentlySelected) {
      setSelectedFolders((prev) => {
        const next = new Set(prev);
        next.delete(folderPath);
        return next;
      });
      return;
    }

    setSelectedFolders((prev) => {
      const next = new Set(prev);
      next.add(folderPath);
      for (const f of Array.from(next)) {
        if (isStrictDescendant(f, folderPath)) next.delete(f);
      }
      return next;
    });
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      for (const file of Array.from(next)) {
        if (isStrictDescendant(file, folderPath)) next.delete(file);
      }
      return next;
    });
  };

  const onToggleFile = (filePath: string) => {
    const currentlySelected = selectedFiles.has(filePath);
    const covered = isCoveredBySelectedFolder(filePath);
    if (!currentlySelected && covered) return;

    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (currentlySelected) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, query]);

  const visibleSelectable = useMemo(() => {
    return filteredEntries.filter((entry) => {
      if (foldersOnly && !entry.is_dir) return false;
      if (filesOnly && entry.is_dir) return false;
      if (isCoveredBySelectedFolder(entry.path)) return false;
      return true;
    });
  }, [filteredEntries, foldersOnly, filesOnly, isCoveredBySelectedFolder]);

  const allVisibleSelected =
    visibleSelectable.length > 0 &&
    visibleSelectable.every((entry) =>
      entry.is_dir ? selectedFolders.has(entry.path) : selectedFiles.has(entry.path),
    );

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedFolders((prev) => {
        const next = new Set(prev);
        for (const entry of visibleSelectable) {
          if (entry.is_dir) next.delete(entry.path);
        }
        return next;
      });
      if (!foldersOnly) {
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          for (const entry of visibleSelectable) {
            if (!entry.is_dir) next.delete(entry.path);
          }
          return next;
        });
      }
      return;
    }

    const foldersToAdd = visibleSelectable.filter((e) => e.is_dir).map((e) => e.path);
    const filesToAdd = foldersOnly
      ? []
      : visibleSelectable.filter((e) => !e.is_dir).map((e) => e.path);

    setSelectedFolders((prev) => {
      const next = new Set(prev);
      for (const folderPath of foldersToAdd) {
        next.add(folderPath);
        for (const f of Array.from(next)) {
          if (isStrictDescendant(f, folderPath)) next.delete(f);
        }
      }
      return next;
    });
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      for (const folderPath of foldersToAdd) {
        for (const file of Array.from(next)) {
          if (isStrictDescendant(file, folderPath)) next.delete(file);
        }
      }
      for (const filePath of filesToAdd) {
        next.add(filePath);
      }
      return next;
    });
  };

  if (!isOpen) return null;

  return (
    <div className="rsp-overlay" onClick={() => resolveRagSourcePicker(null)}>
      <div className="rsp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="rsp-header">
          <div className="rsp-title">
            <Folder size={16} />
            <span>{title}</span>
          </div>
          <button type="button" className="rsp-icon-btn" onClick={() => resolveRagSourcePicker(null)} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="rsp-toolbar">
          <div className="rsp-nav-btns">
            <button type="button" className="rsp-icon-btn" disabled={history.length === 0} onClick={() => void goBack()} title="Back">
              <ArrowLeft size={15} />
            </button>
            <button type="button" className="rsp-icon-btn" disabled={future.length === 0} onClick={() => void goForward()} title="Forward">
              <ArrowRight size={15} />
            </button>
            <button type="button" className="rsp-icon-btn" onClick={() => void goUp()} title="Up">
              <ArrowUp size={15} />
            </button>
            <button type="button" className="rsp-icon-btn" onClick={() => void refresh()} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>

          <input
            className="rsp-path"
            value={currentPath}
            onChange={(e) => setCurrentPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void navigateTo(currentPath.trim());
            }}
            spellCheck={false}
          />

          <div className="rsp-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="rsp-body">
          <aside className="rsp-sidebar">
            <div className="rsp-side-section">
              <div className="rsp-side-label">Places</div>
              {systemRoots.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  className={`rsp-side-item ${
                    normalizeForCompare(currentPath) === normalizeForCompare(r.path) ? "active" : ""
                  }`}
                  onClick={() => void navigateTo(r.path)}
                >
                  {sidebarIcon(r.name)}
                  <span>{r.name}</span>
                </button>
              ))}
            </div>

            {!foldersOnly && volumeRoots.length > 0 && (
              <div className="rsp-side-section">
                <div className="rsp-side-label">Volumes</div>
                {volumeRoots.map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    className={`rsp-side-item ${
                      normalizeForCompare(currentPath) === normalizeForCompare(r.path) ? "active" : ""
                    }`}
                    onClick={() => void navigateTo(r.path)}
                  >
                    <HardDrive size={15} />
                    <span>{r.name}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <main className="rsp-list">
            <div className="rsp-list-head">
              <span className="rsp-col-check" />
              <span className="rsp-col-name">Name</span>
              <span className="rsp-col-date">Date Modified</span>
              <span className="rsp-col-size">Size</span>
            </div>

            <div className="rsp-list-body">
              {loading ? (
                <div className="rsp-empty">Loading…</div>
              ) : error ? (
                <div className="rsp-empty rsp-error">{error}</div>
              ) : filteredEntries.length === 0 ? (
                <div className="rsp-empty">No matching files or folders</div>
              ) : (
                filteredEntries
                  .filter((entry) => !foldersOnly || entry.is_dir)
                  .map((entry) => {
                  const checked = entry.is_dir
                    ? selectedFolders.has(entry.path)
                    : selectedFiles.has(entry.path);
                  const covered = isCoveredBySelectedFolder(entry.path);
                  const disabled = covered && !checked;
                  const folderNotSelectable = filesOnly && entry.is_dir;
                  const checkboxDisabled =
                    disabled ||
                    (!entry.is_dir && foldersOnly) ||
                    folderNotSelectable;

                  return (
                    <div
                      key={entry.path}
                      className={`rsp-row ${disabled ? "disabled" : ""} ${checked ? "selected" : ""}`}
                      onDoubleClick={() => {
                        if (entry.is_dir) void navigateTo(entry.path);
                      }}
                    >
                      <span className="rsp-col-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={checkboxDisabled}
                          onChange={() => {
                            if (entry.is_dir) {
                              if (!filesOnly) onToggleFolder(entry.path);
                            } else if (!foldersOnly) {
                              onToggleFile(entry.path);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </span>

                      <button
                        type="button"
                        className="rsp-col-name rsp-name-btn"
                        disabled={disabled && !entry.is_dir}
                        onClick={() => {
                          if (entry.is_dir) void navigateTo(entry.path);
                          else if (!foldersOnly && !disabled) onToggleFile(entry.path);
                        }}
                      >
                        {entry.is_dir ? <Folder size={15} /> : <FileText size={15} />}
                        <span>{entry.name}</span>
                      </button>

                      <span className="rsp-col-date">{formatMtime(entry.mtime)}</span>
                      <span className="rsp-col-size">{formatSize(entry.size, entry.is_dir)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </main>
        </div>

        <footer className="rsp-footer">
          <div className="rsp-selection-meta">
            {foldersOnly
              ? `${selectedFolders.size} folders`
              : filesOnly
                ? `${selectedFiles.size} files`
                : `${selectedFolders.size} folders · ${selectedFiles.size} files`}
            {!filesOnly ? (
              <span className="rsp-hint">Selecting a folder disables its children</span>
            ) : (
              <span className="rsp-hint">Open folders to browse; select files to attach</span>
            )}
          </div>
          <div className="rsp-actions">
            <button
              type="button"
              className="rsp-btn ghost"
              disabled={visibleSelectable.length === 0 || loading}
              onClick={toggleSelectAllVisible}
            >
              {allVisibleSelected ? "Deselect all" : "Select all"}
            </button>
            <button type="button" className="rsp-btn ghost" onClick={() => resolveRagSourcePicker(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="rsp-btn primary"
              disabled={!hasSelection}
              onClick={() => {
                if (foldersOnly) {
                  resolveRagSourcePicker({
                    folderPaths: Array.from(selectedFolders),
                    filePaths: [],
                  });
                  return;
                }
                if (filesOnly) {
                  resolveRagSourcePicker({
                    folderPaths: [],
                    filePaths: Array.from(selectedFiles),
                  });
                  return;
                }
                setSummaryOpen(true);
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </footer>

        {summaryOpen && (
          <div className="rsp-summary-overlay" onClick={() => setSummaryOpen(false)}>
            <div className="rsp-summary" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <div className="rsp-summary-header">
                <h4>Selected sources</h4>
                <button
                  type="button"
                  className="rsp-icon-btn"
                  onClick={() => setSummaryOpen(false)}
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="rsp-summary-body">
                {selectedFolders.size > 0 && (
                  <section>
                    <div className="rsp-summary-label">Folders ({selectedFolders.size})</div>
                    <ul>
                      {Array.from(selectedFolders).map((p) => (
                        <li key={p}>
                          <Folder size={14} />
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {selectedFiles.size > 0 && (
                  <section>
                    <div className="rsp-summary-label">Files ({selectedFiles.size})</div>
                    <ul>
                      {Array.from(selectedFiles).map((p) => (
                        <li key={p}>
                          <FileText size={14} />
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
              <div className="rsp-summary-actions">
                <button type="button" className="rsp-btn ghost" onClick={() => setSummaryOpen(false)}>
                  Back
                </button>
                <button
                  type="button"
                  className="rsp-btn primary"
                  onClick={() =>
                    resolveRagSourcePicker({
                      folderPaths: Array.from(selectedFolders),
                      filePaths: Array.from(selectedFiles),
                    })
                  }
                >
                  {confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
