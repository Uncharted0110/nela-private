import type { ElementType, ReactNode } from "react";
import type { WorkspaceRecord } from "../types";
import { COPY } from "../app/copy";
import { useCloudStore } from "../stores/cloudStore";
import WorkspaceSelector from "./WorkspaceSelector";
import DocGraphStatusBadge from "./DocGraphStatusBadge";
import "./ModeBanner.css";

interface AppMainTopBarProps {
  currentModeConfig: {
    icon: ElementType;
    label: string;
    desc: string;
  };
  workspaces: WorkspaceRecord[];
  activeWorkspace: WorkspaceRecord | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  workspaceBusy: boolean;
  modelLoadingStatus: {
    loading: boolean;
    modelId: string;
    message: string;
  };
  modeControls: ReactNode;
  networkActive?: boolean;
}

export default function AppMainTopBar({
  currentModeConfig,
  workspaces,
  activeWorkspace,
  onSelectWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  onRenameWorkspace,
  workspaceBusy,
  modelLoadingStatus,
  modeControls,
  networkActive = false,
}: AppMainTopBarProps) {
  const CurrentModeIcon = currentModeConfig.icon;
  const preferredMode = useCloudStore((s) => s.preferredMode);
  const isCloud = preferredMode !== "local";
  const modeLabel = isCloud ? COPY.modeCloudLabel : COPY.modePrivateLabel;
  const modeSub = isCloud ? COPY.modeCloudSub : COPY.modePrivateSub;

  return (
    <header className="app-main-topbar min-h-14 py-2 flex items-center justify-between px-6 border-b border-glass-border bg-void-800/80 backdrop-blur-xl shrink-0 z-40">
      <div className="flex flex-col items-start gap-1.5">
        <div
          className="inline-flex items-center gap-1.5 text-[0.78rem] font-medium text-txt-secondary"
          title={isCloud ? COPY.modeCloudTooltip : COPY.modePrivateTooltip}
        >
          <span className="font-semibold text-txt">{modeLabel}</span>
          <span>· {modeSub}</span>
          {networkActive && (
            <span className="ml-1 text-warning">{COPY.modeDownloading}</span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <CurrentModeIcon size={18} strokeWidth={1.8} className="text-neon" />
          <h1 className="text-[0.95rem] font-semibold m-0 text-txt">{currentModeConfig.label}</h1>
          <span className="text-[0.78rem] text-txt-muted pl-2.5 border-l border-glass-border">
            {currentModeConfig.desc}
          </span>
        </div>

        <WorkspaceSelector
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace?.id ?? null}
          onSelectWorkspace={onSelectWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          onDeleteWorkspace={onDeleteWorkspace}
          onRenameWorkspace={onRenameWorkspace}
          busy={workspaceBusy}
        />

        {modelLoadingStatus.loading && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-900/30 border border-amber-500/40 rounded-lg text-amber-300 text-xs">
            <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <span>{modelLoadingStatus.message || "Loading model..."}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <DocGraphStatusBadge />
        {modeControls}
      </div>
    </header>
  );
}
