import { Globe, Loader2, Scissors, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ChatContextUsage,
  ChatMode,
  ModelFile,
  RegisteredModel,
} from "../types";
import type { DownloadStateMap } from "../app/types";
import type { RuntimeParamsTarget } from "./ActiveModelParamsDock";
import GlassDropdown from "./GlassDropdown";
import ModelSelector from "./ModelSelector";
import { useAdvancedMode } from "../hooks/useAdvancedMode";
import {
  inferStyle,
  RESPONSE_STYLE_OPTIONS,
  RESPONSE_STYLE_PRESETS,
  type ResponseStyle,
} from "../app/responseStylePresets";

interface AppMainModeControlsProps {
  chatMode: ChatMode;
  models: ModelFile[];
  selectedModel: string;
  onModelChange: (path: string) => void;
  onAddModel: () => void;
  onDownloadModel: (modelId: string) => void;
  onCancelDownload: (modelId: string) => void;
  onUninstallModel: (modelId: string) => void;
  onConfirmAction: (
    title: string,
    message: string,
    confirmLabel?: string,
    cancelLabel?: string
  ) => Promise<boolean>;
  downloads: DownloadStateMap;
  ttsEngines: RegisteredModel[];
  selectedTtsEngine: string;
  onSelectTtsEngine: (engineId: string) => void;
  visionModels: RegisteredModel[];
  selectedVisionModel: string;
  onSelectVisionModel: (modelId: string) => void;
  onAddVisionModel: () => void;
  activeRuntimeParamTarget: RuntimeParamsTarget | null;
  paramsDockOpen: boolean;
  onToggleParamsDock: () => void;
  onApplyRuntimeParams: (nextParams: Record<string, string>) => Promise<void>;
  webEnabled?: boolean;
  onToggleWebEnabled?: (enabled: boolean) => void;
  contextUsage: ChatContextUsage | null;
  onCompactContext: () => void;
  canCompactContext: boolean;
  isCompactingContext: boolean;
}

export default function AppMainModeControls({
  chatMode,
  models,
  selectedModel,
  onModelChange,
  onAddModel,
  onDownloadModel,
  onCancelDownload,
  onUninstallModel,
  onConfirmAction,
  downloads,
  ttsEngines,
  selectedTtsEngine,
  onSelectTtsEngine,
  visionModels,
  selectedVisionModel,
  onSelectVisionModel,
  onAddVisionModel,
  activeRuntimeParamTarget,
  paramsDockOpen,
  onToggleParamsDock,
  onApplyRuntimeParams,
  webEnabled = false,
  onToggleWebEnabled,
  contextUsage,
  onCompactContext,
  canCompactContext,
  isCompactingContext,
}: AppMainModeControlsProps) {
  const { advanced } = useAdvancedMode();
  const disabledStyle = !!activeRuntimeParamTarget && activeRuntimeParamTarget.backend !== "LlamaServer";
  const inferredStyle = activeRuntimeParamTarget ? inferStyle(activeRuntimeParamTarget.params) : "balanced";
  const [styleValue, setStyleValue] = useState<ResponseStyle>(inferredStyle);

  useEffect(() => {
    setStyleValue(inferredStyle);
  }, [inferredStyle]);

  const canToggleWeb = chatMode === "text" && typeof onToggleWebEnabled === "function";

  return (
    <div className="flex items-center gap-3">
      {(chatMode === "text" || chatMode === "mindmap") && (
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onSelect={onModelChange}
          type="llm"
          onAdd={onAddModel}
          onDownload={onDownloadModel}
          onCancelDownload={onCancelDownload}
          onUninstall={onUninstallModel}
          onConfirm={onConfirmAction}
          downloads={downloads}
        />
      )}

      {chatMode === "audio" && ttsEngines.length > 0 && (
        <div className="flex items-center gap-2.5">
          <ModelSelector
            models={ttsEngines.map((m) => ({
              name: m.name,
              path: m.id,
              is_downloaded: m.is_downloaded,
              gdrive_id: m.gdrive_id,
            }))}
            selectedModel={selectedTtsEngine}
            onSelect={onSelectTtsEngine}
            type="audio"
            onDownload={onDownloadModel}
            onCancelDownload={onCancelDownload}
            onUninstall={onUninstallModel}
            onConfirm={onConfirmAction}
            downloads={downloads}
          />

          {selectedTtsEngine === "kitten-tts"}
        </div>
      )}

      {chatMode === "vision" && visionModels.length > 0 && (
        <ModelSelector
          models={visionModels.map((m) => ({
            name: m.name,
            path: m.id,
            is_downloaded: m.is_downloaded,
            gdrive_id: m.gdrive_id,
          }))}
          selectedModel={selectedVisionModel}
          onSelect={onSelectVisionModel}
          type="vision"
          onAdd={onAddVisionModel}
          onDownload={onDownloadModel}
          onCancelDownload={onCancelDownload}
          onUninstall={onUninstallModel}
          onConfirm={onConfirmAction}
          downloads={downloads}
        />
      )}

      {activeRuntimeParamTarget && (
        advanced ? (
          <button
            type="button"
            className={`glass-btn inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg cursor-pointer transition-all duration-200 border backdrop-blur-md ${paramsDockOpen ? "bg-neon-subtle text-neon border-neon/30 shadow-[0_0_12px_rgba(0,212,255,0.12)]" : "bg-glass-bg text-txt-secondary border-glass-border hover:border-neon hover:text-neon hover:shadow-[0_0_12px_rgba(0,212,255,0.08)]"}`}
            onClick={onToggleParamsDock}
            title="Model parameters"
            aria-label="Model parameters"
          >
            <SlidersHorizontal size={14} />
            Parameters
          </button>
        ) : (
          <div className="min-w-[180px]">
            <GlassDropdown
              value={styleValue}
              options={RESPONSE_STYLE_OPTIONS.map((o) => ({
                value: o.key,
                label: o.label,
                disabled: disabledStyle,
              }))}
              onChange={(value) => {
                const style = value as ResponseStyle;
                setStyleValue(style);
                void (async () => {
                  try {
                    await onApplyRuntimeParams(RESPONSE_STYLE_PRESETS[style]);
                  } catch {
                    // If apply fails, revert to what the model is actually using.
                    setStyleValue(inferredStyle);
                  }
                })();
              }}
              disabled={disabledStyle}
              placeholder="Response style"
              buttonClassName="glass-btn inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg cursor-pointer transition-all duration-200 border backdrop-blur-md bg-glass-bg text-txt-secondary border-glass-border hover:border-neon hover:text-neon hover:shadow-[0_0_12px_rgba(0,212,255,0.08)]"
            />
          </div>
        )
      )}

      {chatMode === "text" && (
        <button
          type="button"
          className={`glass-btn inline-flex items-center justify-center w-10 h-10 rounded-lg border transition-colors duration-150 ${
            webEnabled
              ? "bg-neon-subtle text-neon border-neon/30"
              : "bg-glass-bg text-txt-muted border-glass-border hover:text-txt"
          } ${canToggleWeb ? "" : "opacity-50 cursor-not-allowed"}`}
          onClick={() => {
            if (!canToggleWeb) return;
            onToggleWebEnabled?.(!webEnabled);
          }}
          title={webEnabled ? "Web search is on" : "Web search is off"}
          aria-label={webEnabled ? "Turn off web search" : "Turn on web search"}
          disabled={!canToggleWeb}
        >
          <Globe size={16} strokeWidth={1.9} />
        </button>
      )}

      {(chatMode === "text" || chatMode === "mindmap") && (
        <button
          className="glass-btn inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg cursor-pointer transition-all duration-200 border border-glass-border bg-glass-bg text-txt-secondary hover:border-neon hover:text-neon disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onCompactContext}
          disabled={!canCompactContext || isCompactingContext}
          title={
            contextUsage
              ? `Compact conversation context (projected usage ${contextUsage.projectedPercent.toFixed(1)}%)`
              : "Compact conversation context"
          }
        >
          {isCompactingContext ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />}
          {isCompactingContext ? "Compacting..." : "Compact Context"}
        </button>
      )}
    </div>
  );
}
