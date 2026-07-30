import { Api } from "../api";
import { COPY } from "./copy";
import {
  STARTUP_MODEL_SELECTOR,
} from "./constants";
import {
  findRegisteredModelByIdentifier,
  normalizeModelRef,
  modelRefBasename,
} from "./modelUtils";
import {
  writeIntelligenceMode,
  writeSpecificModelPicker,
  resolveModeForModelId,
  modelIsDownloadable,
  localModelIdForMode,
  type IntelligenceMode,
} from "./intelligenceModes";
import type { RegisteredModel } from "../types";
import { useModelStore } from "../stores/modelStore";
import { useUIStore } from "../stores/uiStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useChatModeStore } from "../stores/chatModeStore";
import { useCloudStore } from "../stores/cloudStore";

export async function refreshModels(): Promise<RegisteredModel[]> {
  const modelStore = useModelStore.getState();
  
  try {
    const [list, discoveredUnits, catalog] = await Promise.all([
      Api.listRegisteredModels(),
      Api.discoverLocalModelUnits().catch(() => []),
      Api.listModelCatalog().catch(() => []),
    ]);
    
    modelStore.setRegisteredModels(list);
    modelStore.setModelCatalog(catalog);

    // Vision models
    const vision = list.filter((m) => m.tasks.includes("vision_chat"));
    modelStore.setVisionModels(vision);
    if (vision.length > 0) {
      modelStore.setSelectedVisionModel((prev) => prev || vision[0].id);
    }

    // Text models from registry
    const chatModels = list
      .filter((m) => m.tasks.includes("chat"))
      .sort((a, b) => b.priority - a.priority)
      .map((m) => ({
        name:
          m.model_source === "custom"
            ? `${m.name} (Custom${m.model_profile ? ` ${m.model_profile.toUpperCase()}` : ""})`
            : m.name,
        path: m.id,
        is_downloaded: m.is_downloaded,
        gdrive_id: m.gdrive_id,
        downloadable: modelIsDownloadable(m),
        memory_mb: m.memory_mb,
      }));

    // Also include any discovered local model files that are not currently
    // runtime-registered, so manual file drops still appear for selection.
    const registeredTokens = new Set<string>();
    const registeredRepoIds = new Set<string>();
    for (const model of list) {
      registeredTokens.add(normalizeModelRef(model.id));
      if (model.model_file) {
        registeredTokens.add(normalizeModelRef(model.model_file));
        registeredTokens.add(modelRefBasename(model.model_file));
      }
      const repoId = model.params?.hf_repo_id;
      if (repoId) {
        registeredRepoIds.add(repoId.toLowerCase());
      }
    }

    const unregistered = discoveredUnits
      .filter((unit) => {
        const normalizedRel = normalizeModelRef(unit.llm_rel_path);
        const normalizedAbs = normalizeModelRef(unit.llm_abs_path);
        const basename = modelRefBasename(unit.llm_rel_path);
        const byPath =
          registeredTokens.has(normalizedRel) ||
          registeredTokens.has(normalizedAbs) ||
          registeredTokens.has(basename);
        const byRepo = registeredRepoIds.has(unit.repo_id.toLowerCase());
        return !byPath && !byRepo;
      })
      .map((unit) => ({
        name: `${unit.repo_id} (${unit.llm_file_name}) (Unregistered)`,
        path: unit.llm_abs_path,
        is_downloaded: true,
        gdrive_id: null as string | null,
      }))
      .filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.path === entry.path) === index
      );

    const allChatModels = [...chatModels, ...unregistered];
    modelStore.setModels(allChatModels);
    if (allChatModels.length > 0) {
      modelStore.setSelectedModel((prev) => prev || allChatModels[0].path);
    }

    // TTS engines from the registry
    const tts = list.filter((m) => m.tasks.includes("tts"));
    modelStore.setTtsEngines(tts);
    if (tts.length > 0) {
      modelStore.setSelectedTtsEngine((prev) => prev || tts[0].id);
    }

    return list;
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function handleDownloadModel(modelId: string): Promise<void> {
  const uiStore = useUIStore.getState();
  try {
    await Api.downloadModel(modelId);
  } catch (e) {
    console.error("Failed to download model", e);
    uiStore.showError(`Failed to download model: ${String(e)}`);
  }
}

export async function handleCancelDownload(modelId: string): Promise<void> {
  const uiStore = useUIStore.getState();
  const downloadStore = useDownloadStore.getState();
  
  try {
    await Api.cancelDownload(modelId);
    downloadStore.clearDownload(modelId);
  } catch (e) {
    console.error("Failed to cancel download", e);
    uiStore.showError(`Failed to cancel download: ${String(e)}`);
  }
}

export async function handleUninstall(modelId: string): Promise<void> {
  const uiStore = useUIStore.getState();
  try {
    await Api.uninstallModel(modelId);
    setTimeout(refreshModels, 1000);
  } catch (e) {
    console.error("Failed to uninstall model", e);
    uiStore.showError(`Failed to uninstall model: ${String(e)}`);
  }
}

export async function handleModelChange(path: string): Promise<void> {
  const modelStore = useModelStore.getState();
  const uiStore = useUIStore.getState();
  
  if (modelStore.modelSwitching.active) return;
  if (path === modelStore.selectedModel) return;

  const label =
    modelStore.models.find((m) => m.path === path)?.name ??
    modelStore.registeredModels.find((m) => m.id === path)?.name ??
    path;

  modelStore.setModelSwitching({ active: true, targetLabel: label });
  modelStore.setModelLoadingStatus({
    loading: true,
    modelId: path,
    message: `Switching to ${label}...`,
  });

  try {
    const activeId = await Api.switchModel(path);

    const refreshed = await refreshModels();
    const resolved =
      findRegisteredModelByIdentifier(refreshed, activeId) ??
      findRegisteredModelByIdentifier(refreshed, path);
    if (resolved) {
      modelStore.setSelectedModel(resolved.id);
    } else {
      modelStore.setSelectedModel(activeId);
    }
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    uiStore.showError(`Failed to switch model: ${msg}`);
  } finally {
    modelStore.setModelSwitching({ active: false, targetLabel: "" });
  }
}

export function formatModelSizeLabel(memoryMb?: number): string {
  if (typeof memoryMb !== "number" || !Number.isFinite(memoryMb) || memoryMb <= 0) return "";
  if (memoryMb >= 1024) return `${(memoryMb / 1024).toFixed(1)} GB`;
  return `${Math.round(memoryMb)} MB`;
}

export function resolveCatalogModel(modelId: string): RegisteredModel | undefined {
  const modelStore = useModelStore.getState();
  return (
    modelStore.modelCatalog.find((m) => m.id === modelId) ??
    modelStore.registeredModels.find((m) => m.id === modelId)
  );
}

export async function waitForModelDownload(modelId: string, timeoutMs = 45 * 60 * 1000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const catalog = await Api.listModelCatalog().catch(() => []);
    const entry = catalog.find((m) => m.id === modelId);
    if (entry?.is_downloaded) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function ensureDownloadedAndSwitch(modelId: string): Promise<void> {
  const uiStore = useUIStore.getState();
  const entry = resolveCatalogModel(modelId);
  
  if (entry && !entry.is_downloaded && modelIsDownloadable(entry)) {
    const ok = await uiStore.confirmAction(
      "Download model",
      COPY.intelligenceDownloadPrompt(entry.name, formatModelSizeLabel(entry.memory_mb)),
      "Download",
      "Cancel"
    );
    if (!ok) return;
    
    await handleDownloadModel(modelId);
    const ready = await waitForModelDownload(modelId);
    if (!ready) {
      uiStore.showError("Download is still in progress. Try switching again once it finishes.");
      return;
    }
    await refreshModels();
  }
  await handleModelChange(modelId);
}

export async function handleIntelligenceModeSelect(mode: IntelligenceMode): Promise<void> {
  const modelStore = useModelStore.getState();
  const uiStore = useUIStore.getState();
  const { preferredMode } = useCloudStore.getState();

  // In Cloud (or prefer-cloud auto) mode, intelligence tiers map 1:1 to cloud
  // quality tiers, so switching tiers must NOT prompt a local model download or
  // the local deep-load warning. Only the private/local path touches on-device
  // models.
  const cloudMode = preferredMode !== "local";

  if (!cloudMode && mode === "deep") {
    const ok = await uiStore.confirmAction(
      "Deep mode",
      COPY.intelligenceDeepLoadWarning,
      "Continue",
      "Cancel"
    );
    if (!ok) return;
  }

  writeIntelligenceMode(mode);
  modelStore.setIntelligenceMode(mode);
  modelStore.setUseSpecificModelPicker(false);
  writeSpecificModelPicker(false);

  if (cloudMode) {
    // Tier is set; cloud routing at send time uses cloudQualityModeForIntelligence.
    return;
  }

  const modelId = localModelIdForMode(mode, modelStore.intelligenceMapping);
  await ensureDownloadedAndSwitch(modelId);
}

export async function handleModelChangeFromPicker(path: string): Promise<void> {
  const modelStore = useModelStore.getState();
  const uiStore = useUIStore.getState();
  
  modelStore.setUseSpecificModelPicker(true);
  writeSpecificModelPicker(true);

  const entry = resolveCatalogModel(path);
  if (entry && !entry.is_downloaded && modelIsDownloadable(entry)) {
    const ok = await uiStore.confirmAction(
      "Download model",
      COPY.intelligenceDownloadPrompt(entry.name, formatModelSizeLabel(entry.memory_mb)),
      "Download",
      "Cancel"
    );
    if (!ok) return;
    
    await handleDownloadModel(path);
    const ready = await waitForModelDownload(path);
    if (!ready) {
      uiStore.showError("Download is still in progress. Try switching again once it finishes.");
      return;
    }
    await refreshModels();
  }

  await handleModelChange(path);
}

export function handleChooseSpecificModel(): void {
  const { preferredMode } = useCloudStore.getState();
  // Cloud mode uses OpenRouter quality tiers only — no local model picker.
  if (preferredMode !== "local") return;
  const modelStore = useModelStore.getState();
  modelStore.setUseSpecificModelPicker(true);
  writeSpecificModelPicker(true);
}

export async function handleBackToIntelligenceTiers(): Promise<void> {
  const modelStore = useModelStore.getState();
  const { preferredMode } = useCloudStore.getState();
  modelStore.setUseSpecificModelPicker(false);
  writeSpecificModelPicker(false);
  if (preferredMode !== "local") return;
  await ensureDownloadedAndSwitch(
    localModelIdForMode(modelStore.intelligenceMode, modelStore.intelligenceMapping)
  );
}

export async function handleApplyRuntimeParams(nextParams: Record<string, string>): Promise<void> {
  const modelStore = useModelStore.getState();
  const chatModeStore = useChatModeStore.getState();
  const activeRuntimeParamTarget = getActiveRuntimeParamTarget();
  
  if (!activeRuntimeParamTarget) return;

  const targetIdentifier = activeRuntimeParamTarget.identifier;
  let resolved = findRegisteredModelByIdentifier(modelStore.registeredModels, targetIdentifier);

  // Auto-bind path-only models (for manually placed/HF-downloaded GGUF files)
  // by forcing a model switch first, then refreshing the registry.
  if (!resolved && (chatModeStore.chatMode === "text" || chatModeStore.chatMode === "mindmap" || chatModeStore.chatMode === "vision")) {
    try {
      await Api.switchModel(targetIdentifier);
      const refreshed = await refreshModels();
      resolved = findRegisteredModelByIdentifier(refreshed, targetIdentifier);
    } catch (err) {
      console.warn("Failed to auto-bind model before applying params", err);
    }
  }

  if (resolved) {
    await Api.updateModelParams(resolved.id, nextParams);
    modelStore.setSessionModelParamOverrides((prev) => {
      const next = { ...prev };
      delete next[targetIdentifier];
      delete next[resolved.id];
      return next;
    });

    // Ensure the selected chat model is activated so startup-level params
    // (for example ctx_size / flash_attn / mlock) are effective immediately.
    if (chatModeStore.chatMode === "text" || chatModeStore.chatMode === "mindmap") {
      await Api.switchModel(resolved.id);
    }

    await refreshModels();

    if (
      (chatModeStore.chatMode === "text" || chatModeStore.chatMode === "mindmap") &&
      modelStore.selectedModel === targetIdentifier
    ) {
      modelStore.setSelectedModel(resolved.id);
    }
    return;
  }

  throw new Error(
    "Could not apply runtime parameters because the selected model is not bound to the runtime registry. Re-select the model and try again."
  );
}

export async function downloadMissingOptionalModels(): Promise<void> {
  const modelStore = useModelStore.getState();
  const downloadStore = useDownloadStore.getState();
  
  const list = modelStore.registeredModels.length > 0
    ? modelStore.registeredModels
    : await Api.listRegisteredModels();
  
  if (modelStore.registeredModels.length === 0) {
    modelStore.setRegisteredModels(list);
  }

  const missing = getOptionalModels(list)
    .filter((model) => model.gdrive_id && !model.is_downloaded)
    .filter((model) => !downloadStore.downloads[model.id]);

  for (const model of missing) {
    await handleDownloadModel(model.id);
  }
}

function getOptionalModels(list: RegisteredModel[]): RegisteredModel[] {
  return list.filter(
    (model) =>
      model.tasks.some((t) => STARTUP_MODEL_SELECTOR.tasks.has(t)) ||
      STARTUP_MODEL_SELECTOR.ids.has(model.id)
  );
}

export function getActiveRuntimeParamTarget(): {
  key: string;
  identifier: string;
  displayName: string;
  backend: string;
  modelFile?: string;
  memoryMb?: number;
  params: Record<string, string>;
  isRegistered: boolean;
} | null {
  const modelStore = useModelStore.getState();
  const chatModeStore = useChatModeStore.getState();
  
  const createTarget = (
    identifier: string | null | undefined,
    fallbackBackend: string,
    fallbackName?: string
  ) => {
    if (!identifier) return null;

    const resolved = findRegisteredModelByIdentifier(modelStore.registeredModels, identifier);
    const discoveredName =
      fallbackName ||
      modelStore.models.find((model) => model.path === identifier)?.name ||
      identifier;

    return {
      key: `${chatModeStore.chatMode}:${resolved?.id ?? identifier}`,
      identifier,
      displayName: discoveredName.replace(/\s*\(Unregistered\)$/i, ""),
      backend: resolved?.backend ?? fallbackBackend,
      modelFile: resolved?.model_file,
      memoryMb: resolved?.memory_mb,
      params: modelStore.getModelParams(identifier),
      isRegistered: !!resolved,
    };
  };

  if (chatModeStore.chatMode === "text" || chatModeStore.chatMode === "mindmap") {
    return createTarget(modelStore.selectedModel, "LlamaServer");
  }

  if (chatModeStore.chatMode === "audio") {
    const selectedEngine = modelStore.ttsEngines.find((engine) => engine.id === modelStore.selectedTtsEngine);
    return createTarget(modelStore.selectedTtsEngine, selectedEngine?.backend ?? "KittenTts", selectedEngine?.name);
  }

  if (chatModeStore.chatMode === "vision") {
    const selectedVision = modelStore.visionModels.find((model) => model.id === modelStore.selectedVisionModel);
    return createTarget(modelStore.selectedVisionModel, selectedVision?.backend ?? "LlamaServer", selectedVision?.name);
  }

  return null;
}

export function intelligenceDisplayMode(): IntelligenceMode | "custom" {
  const modelStore = useModelStore.getState();
  const { preferredMode } = useCloudStore.getState();

  // Cloud / prefer-cloud: Fast·Smart·Deep are quality tiers for OpenRouter.
  // Always show the stored intelligence mode — do NOT derive from the local GGUF.
  if (preferredMode !== "local") {
    return modelStore.intelligenceMode;
  }

  if (modelStore.useSpecificModelPicker) return "custom";
  const matched = resolveModeForModelId(modelStore.selectedModel, modelStore.intelligenceMapping);
  return matched ?? "custom";
}