import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FolderSearch, HardDrive, Loader2, X } from "lucide-react";
import { openRagSourcePicker } from "../stores/ragSourcePickerStore";
import { useFileIndexerStore } from "../stores/fileIndexerStore";
import "./FileIndexerSetupModal.css";

export default function FileIndexerSetupModal() {
  const setupOpen = useFileIndexerStore((s) => s.setupOpen);
  const closeSetup = useFileIndexerStore((s) => s.closeSetup);
  const model = useFileIndexerStore((s) => s.model);
  const config = useFileIndexerStore((s) => s.config);
  const defaultRoots = useFileIndexerStore((s) => s.defaultRoots);
  const completeSetup = useFileIndexerStore((s) => s.completeSetup);

  const reconfigure = !!config?.setupDone;

  const [step, setStep] = useState<"mode" | "confirm">("mode");
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!setupOpen) return;
    setBusy(false);
    setError(null);
    const existingMode = config?.mode === "custom" ? "custom" : "default";
    const existingRoots = config?.roots ?? [];
    setMode(existingMode);
    setRoots(existingRoots);
    setStep(existingRoots.length > 0 ? "confirm" : "mode");
  }, [setupOpen, config]);

  const selectedRoots = useMemo(
    () => (mode === "default" ? defaultRoots : roots),
    [mode, defaultRoots, roots],
  );

  if (!setupOpen) return null;

  const pickCustomFolders = async () => {
    setError(null);
    const selection = await openRagSourcePicker({
      allowedExtensions: [],
      foldersOnly: true,
    });
    if (!selection) return;
    if (selection.folderPaths.length === 0) {
      setError("Select at least one folder.");
      return;
    }
    setRoots(selection.folderPaths);
    setMode("custom");
    setStep("confirm");
  };

  const goConfirmDefault = () => {
    setError(null);
    if (defaultRoots.length === 0) {
      setError("Could not resolve your home folder.");
      return;
    }
    setMode("default");
    setRoots(defaultRoots);
    setStep("confirm");
  };

  const onProceed = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!model?.present) {
        throw new Error(
          `Embedding model not found at ${model?.modelDir ?? "(unknown)"}. Place models--Qdrant--all-MiniLM-L6-v2-onnx under the cache dir.`,
        );
      }
      await completeSetup(mode, selectedRoots);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fi-setup-overlay">
      <div className="fi-setup-card" role="dialog" aria-modal="true" aria-labelledby="fi-setup-title">
        <div className="fi-setup-header">
          <FolderSearch size={22} />
          <div style={{ flex: 1 }}>
            <h2 id="fi-setup-title">
              {reconfigure ? "Reconfigure file indexing" : "File indexing setup"}
            </h2>
            <p>
              {reconfigure
                ? "Change which folders NELA indexes. Saving rebuilds the index in the background."
                : "Choose what NELA should index in the background for local file search."}
            </p>
          </div>
          <button
            type="button"
            className="fi-btn ghost"
            aria-label="Close"
            disabled={busy}
            onClick={() => closeSetup()}
            style={{ padding: "0.35rem" }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="fi-setup-model">
          <div className="fi-setup-model-title">Required model</div>
          <div className="fi-setup-model-row">
            <span>{model?.name ?? "all-MiniLM-L6-v2 (quantized ONNX)"}</span>
            <span className={model?.present ? "fi-ok" : "fi-missing"}>
              {model?.present ? (
                <>
                  <CheckCircle2 size={14} /> Ready (~{model.sizeMb} MB)
                </>
              ) : (
                <>Missing — place under {model?.cacheDir}</>
              )}
            </span>
          </div>
          {model?.modelDir && <div className="fi-setup-path">{model.modelDir}</div>}
        </div>

        {step === "mode" && (
          <div className="fi-setup-modes">
            <label className={`fi-mode ${mode === "default" ? "active" : ""}`}>
              <input
                type="radio"
                name="fi-mode"
                checked={mode === "default"}
                onChange={() => setMode("default")}
              />
              <HardDrive size={18} />
              <div>
                <strong>Default</strong>
                <span>Index your home folder only (not system files).</span>
              </div>
            </label>
            <label className={`fi-mode ${mode === "custom" ? "active" : ""}`}>
              <input
                type="radio"
                name="fi-mode"
                checked={mode === "custom"}
                onChange={() => setMode("custom")}
              />
              <FolderSearch size={18} />
              <div>
                <strong>Custom</strong>
                <span>Pick specific folders inside your home directory.</span>
              </div>
            </label>

            <div className="fi-setup-actions">
              <button type="button" className="fi-btn ghost" onClick={() => closeSetup()}>
                Cancel
              </button>
              {mode === "default" ? (
                <button type="button" className="fi-btn primary" onClick={goConfirmDefault}>
                  Continue
                </button>
              ) : (
                <button type="button" className="fi-btn primary" onClick={() => void pickCustomFolders()}>
                  Choose folders
                </button>
              )}
            </div>
          </div>
        )}

        {step === "confirm" && (
          <div className="fi-setup-confirm">
            <h3>{reconfigure ? "Folders currently selected" : "These folders will be indexed"}</h3>
            <ul>
              {selectedRoots.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="fi-setup-note">
              {reconfigure
                ? "Proceeding stops the current indexer and rebuilds from these folders."
                : "Indexing runs in the background after you proceed. You can keep using NELA while it works."}
            </p>
            <div className="fi-setup-actions">
              <button
                type="button"
                className="fi-btn ghost"
                disabled={busy}
                onClick={() => setStep("mode")}
              >
                Change
              </button>
              <button type="button" className="fi-btn primary" disabled={busy} onClick={() => void onProceed()}>
                {busy ? (
                  <>
                    <Loader2 size={16} className="fi-spin" /> Starting…
                  </>
                ) : reconfigure ? (
                  "Save & reindex"
                ) : (
                  "Proceed with installation"
                )}
              </button>
            </div>
          </div>
        )}

        {error && <div className="fi-setup-error">{error}</div>}
      </div>
    </div>
  );
}
