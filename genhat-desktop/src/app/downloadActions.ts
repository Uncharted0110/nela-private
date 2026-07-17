import { Api } from "../api";
import { useDownloadStore, startupCancelRequested, setStartupCancelRequested } from "../stores/downloadStore";
import { handleCancelDownload } from "./modelActions";

export function handleStartupToastDecline(): void {
  const downloadStore = useDownloadStore.getState();
  downloadStore.setStartupModelToast((prev) => ({
    ...prev,
    open: true,
    phase: "declined",
    message: "You can download these models from Settings or clicking on the drop-down any time.",
  }));
}

export async function handleStartupToastAccept(): Promise<void> {
  const downloadStore = useDownloadStore.getState();
  const ids = downloadStore.startupModelToast.selectedIds;
  
  if (ids.length === 0) {
    downloadStore.setStartupModelToast((prev) => ({
      ...prev,
      open: true,
      phase: "declined",
      message: "No models selected. You can download models from Settings any time.",
    }));
    return;
  }

  downloadStore.setStartupModelToast((prev) => ({
    ...prev,
    open: true,
    phase: "downloading",
    message: "Starting parallel downloads...",
    total: ids.length,
    doneIds: [],
    failedIds: [],
    completed: 0,
    failed: 0,
  }));
  
  downloadStore.setStartupToastMinimized(false);
  setStartupCancelRequested(false);
  downloadStore.setStartupCancellingIds([]);
  downloadStore.setStartupCancelledIds([]);

  let completed = 0;
  let failed = 0;
  
  await Promise.all(
    ids.map(async (modelId) => {
      try {
        await Api.downloadModel(modelId);
        completed += 1;
        downloadStore.patchStartupToast((prev) => ({
          ...prev,
          doneIds: prev.doneIds.includes(modelId) ? prev.doneIds : [...prev.doneIds, modelId],
        }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const cancelled = /cancel/i.test(message);

        if (cancelled) {
          setStartupCancelRequested(true);
          downloadStore.setStartupCancelledIds((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));
          downloadStore.patchStartupToast((prev) => ({
            ...prev,
            failedIds: prev.failedIds.includes(modelId) ? prev.failedIds : [...prev.failedIds, modelId],
          }));
        } else {
          failed += 1;
          console.error("Failed startup model download", e);
          downloadStore.patchStartupToast((prev) => ({
            ...prev,
            failedIds: prev.failedIds.includes(modelId) ? prev.failedIds : [...prev.failedIds, modelId],
          }));
        }
      } finally {
        downloadStore.setStartupCancellingIds((prev) => prev.filter((id) => id !== modelId));
        downloadStore.patchStartupToast((prev) => ({
          ...prev,
          completed,
          failed,
        }));
      }
    })
  );

  if (startupCancelRequested.current) {
    downloadStore.setStartupModelToast((prev) => ({
      ...prev,
      open: true,
      phase: "done",
      message: `Download cancelled. ${completed}/${ids.length} completed before cancellation.`,
    }));
  } else if (failed > 0) {
    downloadStore.setStartupModelToast((prev) => ({
      ...prev,
      open: true,
      phase: "done",
      message: `Downloads finished: ${completed}/${ids.length} completed, ${failed} failed. You can retry from Settings.`,
    }));
  } else {
    downloadStore.setStartupModelToast((prev) => ({
      ...prev,
      open: true,
      phase: "done",
      message: `All ${ids.length} model download(s) completed.`,
    }));
  }
}

export async function handleStartupToastCancelSingleDownload(modelId: string): Promise<void> {
  const downloadStore = useDownloadStore.getState();
  const toast = downloadStore.startupModelToast;
  
  if (toast.phase !== "downloading") return;
  if (toast.doneIds.includes(modelId) || toast.failedIds.includes(modelId)) return;

  setStartupCancelRequested(true);
  downloadStore.setStartupCancellingIds((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));

  try {
    await handleCancelDownload(modelId);
  } catch (e) {
    downloadStore.setStartupCancellingIds((prev) => prev.filter((id) => id !== modelId));
    console.error("Failed to cancel startup model download", e);
    // Note: error already handled in handleCancelDownload
  }
}

export async function handleStartupToastCancelDownloads(): Promise<void> {
  const downloadStore = useDownloadStore.getState();
  const toast = downloadStore.startupModelToast;
  
  if (toast.phase !== "downloading") return;

  const activeIds = toast.selectedIds.filter(
    (modelId) =>
      !toast.doneIds.includes(modelId) &&
      !toast.failedIds.includes(modelId)
  );

  if (activeIds.length === 0) return;

  setStartupCancelRequested(true);
  downloadStore.setStartupCancellingIds((prev) => Array.from(new Set([...prev, ...activeIds])));
  downloadStore.setStartupModelToast((prev) => ({
    ...prev,
    message: "Cancelling downloads...",
  }));

  await Promise.allSettled(activeIds.map((modelId) => handleStartupToastCancelSingleDownload(modelId)));
}

export function toggleStartupModelSelection(modelId: string): void {
  const downloadStore = useDownloadStore.getState();
  downloadStore.patchStartupToast((prev) => {
    if (prev.phase !== "prompt") return prev;
    const selected = prev.selectedIds.includes(modelId)
      ? prev.selectedIds.filter((id) => id !== modelId)
      : [...prev.selectedIds, modelId];
    return { ...prev, selectedIds: selected };
  });
}

export function startupOverallSpeedBps(): number {
  const downloadStore = useDownloadStore.getState();
  if (downloadStore.startupModelToast.phase !== "downloading") return 0;
  
  return downloadStore.startupModelToast.selectedIds.reduce((sum, modelId) => {
    const speed = downloadStore.downloads[modelId]?.speedBps;
    if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
      return sum;
    }
    return sum + speed;
  }, 0);
}

export function startupSelectedTotalMb(): number {
  const downloadStore = useDownloadStore.getState();
  const toast = downloadStore.startupModelToast;
  let total = 0;
  
  toast.selectedIds.forEach((modelId) => {
    const idx = toast.missingIds.indexOf(modelId);
    if (idx < 0) return;
    const mb = toast.missingSizesMb[idx];
    if (typeof mb === "number" && Number.isFinite(mb) && mb > 0) total += mb;
  });
  
  return total;
}