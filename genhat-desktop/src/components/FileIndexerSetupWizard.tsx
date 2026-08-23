import React, { useEffect, useMemo, useState } from "react";
import { FolderSearch, Loader2 } from "lucide-react";
import {
  fileindexerDownloadModel,
  fileindexerListDefaultRoots,
  fileindexerSaveSetup,
} from "../api";
import { openRagSourcePicker } from "../stores/ragSourcePickerStore";
import { friendlyErrorFromUnknown } from "../app/friendlyError";
import "./FileIndexerSetupWizard.css";

type Step = "mode" | "custom" | "confirm" | "model";

interface FileIndexerSetupWizardProps {
  modelDir: string;
  onComplete: () => void;
}

const FileIndexerSetupWizard: React.FC<FileIndexerSetupWizardProps> = ({
  modelDir,
  onComplete,
}) => {
  const [step, setStep] = useState<Step>("mode");
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [roots, setRoots] = useState<string[]>([]);
  const [downloadModel, setDownloadModel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ message?: string }>(
        "fileindexer-download-progress",
        (event) => {
          setProgress(event.payload.message ?? "Working…");
        },
      );
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const stepLabel = useMemo(() => {
    switch (step) {
      case "mode":
        return "Step 1 of 4";
      case "custom":
        return "Step 2 of 4";
      case "confirm":
        return "Step 3 of 4";
      case "model":
        return "Step 4 of 4";
      default:
        return "";
    }
  }, [step]);

  const loadDefaultRoots = async () => {
    const defaults = await fileindexerListDefaultRoots();
    setRoots(defaults);
    return defaults;
  };

  const goNextFromMode = async () => {
    setError(null);
    if (mode === "default") {
      setBusy(true);
      try {
        const defaults = await loadDefaultRoots();
        if (defaults.length === 0) {
          setError("No folders were found to index. Choose Custom and add folders manually.");
          return;
        }
        setStep("confirm");
      } catch (e) {
        setError(friendlyErrorFromUnknown(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setStep("custom");
  };

  const addFolder = async () => {
    setError(null);
    try {
      const selection = await openRagSourcePicker({
        allowedExtensions: [],
        foldersOnly: true,
      });
      if (!selection || selection.folderPaths.length === 0) return;
      const next = selection.folderPaths[0];
      setRoots((prev) => (prev.includes(next) ? prev : [...prev, next]));
    } catch (e) {
      setError(friendlyErrorFromUnknown(e));
    }
  };

  const removeFolder = (path: string) => {
    setRoots((prev) => prev.filter((item) => item !== path));
  };

  const goNextFromCustom = () => {
    setError(null);
    if (roots.length === 0) {
      setError("Add at least one folder, or go back and choose Default.");
      return;
    }
    setStep("confirm");
  };

  const finishSetup = async () => {
    setError(null);
    setBusy(true);
    setProgress(null);
    try {
      await fileindexerSaveSetup(mode, roots);
      if (downloadModel) {
        setProgress("Downloading FileIndexer embedding model…");
        try {
          await fileindexerDownloadModel();
        } catch (e) {
          setError(
            `${friendlyErrorFromUnknown(e)} Install will continue without the embedding model.`,
          );
        }
      }
      onComplete();
    } catch (e) {
      setError(friendlyErrorFromUnknown(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="fi-setup-overlay">
      <div className="fi-setup-card" role="dialog" aria-modal="true" aria-labelledby="fi-setup-title">
        <p className="fi-setup-step">{stepLabel}</p>
        <h2 id="fi-setup-title" className="fi-setup-title">
          {step === "mode" && "Choose folders for local file search"}
          {step === "custom" && "Add folders to index"}
          {step === "confirm" && "Confirm indexed folders"}
          {step === "model" && "Download embedding model?"}
        </h2>

        {step === "mode" && (
          <>
            <p className="fi-setup-copy">
              NELA can index files on this computer for local search in chat. Pick a default set of
              folders or choose your own. The embedding model can be downloaded on the next step into{" "}
              <code>{modelDir}</code>.
            </p>
            <label className="fi-setup-radio">
              <input
                type="radio"
                name="fi-mode"
                checked={mode === "default"}
                onChange={() => setMode("default")}
              />
              <span>Default — index home and mounted volumes</span>
            </label>
            <label className="fi-setup-radio">
              <input
                type="radio"
                name="fi-mode"
                checked={mode === "custom"}
                onChange={() => setMode("custom")}
              />
              <span>Custom — choose specific folders</span>
            </label>
          </>
        )}

        {step === "custom" && (
          <>
            <p className="fi-setup-copy">
              Add folders to index. Selecting a parent folder includes everything underneath.
            </p>
            <div className="fi-setup-actions-row">
              <button type="button" className="fi-setup-btn secondary" onClick={() => void addFolder()}>
                <FolderSearch size={16} />
                Add folder
              </button>
            </div>
            <ul className="fi-setup-list">
              {roots.length === 0 ? (
                <li className="fi-setup-empty">No folders added yet.</li>
              ) : (
                roots.map((root) => (
                  <li key={root}>
                    <span>{root}</span>
                    <button type="button" className="fi-setup-link" onClick={() => removeFolder(root)}>
                      Remove
                    </button>
                  </li>
                ))
              )}
            </ul>
          </>
        )}

        {step === "confirm" && (
          <>
            <p className="fi-setup-copy">These folders will be indexed after setup completes.</p>
            <ul className="fi-setup-list">
              {roots.map((root) => (
                <li key={root}>{root}</li>
              ))}
            </ul>
          </>
        )}

        {step === "model" && (
          <>
            <p className="fi-setup-copy">
              Download the local file-search embedding model (all-MiniLM-L6-v2 ONNX, ~90 MB)? Without
              it, FileIndexer will not work until the model is installed under{" "}
              <code>{modelDir}</code>.
            </p>
            <label className="fi-setup-radio">
              <input
                type="radio"
                name="fi-model"
                checked={downloadModel}
                onChange={() => setDownloadModel(true)}
              />
              <span>Yes — download now</span>
            </label>
            <label className="fi-setup-radio">
              <input
                type="radio"
                name="fi-model"
                checked={!downloadModel}
                onChange={() => setDownloadModel(false)}
              />
              <span>No — finish setup without the model</span>
            </label>
            <p className="fi-setup-note">Requires internet. Setup always completes either way.</p>
          </>
        )}

        {error && <p className="fi-setup-error">{error}</p>}
        {progress && (
          <p className="fi-setup-progress">
            <Loader2 size={14} className="fi-setup-spin" />
            {progress}
          </p>
        )}

        <div className="fi-setup-footer">
          {step !== "mode" && step !== "model" && (
            <button
              type="button"
              className="fi-setup-btn secondary"
              disabled={busy}
              onClick={() =>
                setStep(step === "confirm" ? (mode === "custom" ? "custom" : "mode") : "mode")
              }
            >
              Back
            </button>
          )}
          {step === "model" && (
            <button
              type="button"
              className="fi-setup-btn secondary"
              disabled={busy}
              onClick={() => setStep("confirm")}
            >
              Back
            </button>
          )}

          {step === "mode" && (
            <button type="button" className="fi-setup-btn primary" disabled={busy} onClick={() => void goNextFromMode()}>
              Next
            </button>
          )}
          {step === "custom" && (
            <button type="button" className="fi-setup-btn primary" disabled={busy} onClick={goNextFromCustom}>
              Next
            </button>
          )}
          {step === "confirm" && (
            <button type="button" className="fi-setup-btn primary" disabled={busy} onClick={() => setStep("model")}>
              Next
            </button>
          )}
          {step === "model" && (
            <button type="button" className="fi-setup-btn primary" disabled={busy} onClick={() => void finishSetup()}>
              {busy ? "Finishing…" : "Finish setup"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FileIndexerSetupWizard;
