import { create } from "zustand";
import type { WorkspaceRecord } from "../types";

interface WorkspaceState {
  workspaceScope: string | null;
  workspaces: WorkspaceRecord[];
  activeWorkspace: WorkspaceRecord | null;
  startupContinueWorkspace: WorkspaceRecord | null;
  workspaceBusy: boolean;
}

type Updater<T> = T | ((prev: T) => T);

interface WorkspaceActions {
  setWorkspaceScope: (scope: Updater<string | null>) => void;
  setWorkspaces: (workspaces: Updater<WorkspaceRecord[]>) => void;
  setActiveWorkspace: (workspace: Updater<WorkspaceRecord | null>) => void;
  setStartupContinueWorkspace: (workspace: Updater<WorkspaceRecord | null>) => void;
  setWorkspaceBusy: (busy: Updater<boolean>) => void;
}

function applyUpdater<T>(prev: T, value: Updater<T>): T {
  return typeof value === "function" ? (value as (p: T) => T)(prev) : value;
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set) => ({
  workspaceScope: null,
  workspaces: [],
  activeWorkspace: null,
  startupContinueWorkspace: null,
  workspaceBusy: false,

  setWorkspaceScope: (workspaceScope) =>
    set((s) => ({ workspaceScope: applyUpdater(s.workspaceScope, workspaceScope) })),

  setWorkspaces: (workspaces) =>
    set((s) => ({ workspaces: applyUpdater(s.workspaces, workspaces) })),

  setActiveWorkspace: (activeWorkspace) =>
    set((s) => ({
      activeWorkspace: applyUpdater(s.activeWorkspace, activeWorkspace),
    })),

  setStartupContinueWorkspace: (startupContinueWorkspace) =>
    set((s) => ({
      startupContinueWorkspace: applyUpdater(
        s.startupContinueWorkspace,
        startupContinueWorkspace
      ),
    })),

  setWorkspaceBusy: (workspaceBusy) =>
    set((s) => ({ workspaceBusy: applyUpdater(s.workspaceBusy, workspaceBusy) })),
}));