import type {
  ChatSession,
  IngestionStatus,
  MindMapGraph,
  WorkspaceRecord,
} from "../types";
import type { MindmapOverlayState } from "../stores/chatModeStore";
import { useSessionStore } from "../stores/sessionStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useChatModeStore } from "../stores/chatModeStore";
import { useModelStore } from "../stores/modelStore";
import {
  createNewWorkspaceAction,
  deleteWorkspaceByIdAction,
  loadRagDocsAction,
  openWorkspaceFromFileAction,
  refreshWorkspaceListOnlyAction,
  refreshWorkspaceRegistryAction,
  renameWorkspaceByIdAction,
  saveWorkspaceAsFileAction,
  saveWorkspaceFileAction,
  switchWorkspaceByIdAction,
  type WorkspaceMutationContext,
} from "./workspaceActions";
import type { SetStateAction } from "react";
import { sessionForPersistence } from "./sessionUtils";

function resolveSetStateAction<T>(prevValue: T, action: SetStateAction<T>): T {
  return typeof action === "function"
    ? (action as (prev: T) => T)(prevValue)
    : action;
}

export function getWorkspaceMutationContext(): WorkspaceMutationContext {
  const sessionStore = useSessionStore.getState();
  const workspaceStore = useWorkspaceStore.getState();
  const chatModeStore = useChatModeStore.getState();

  return {
    workspaceBusy: workspaceStore.workspaceBusy,
    setWorkspaceBusy: (action: SetStateAction<boolean>) =>
      workspaceStore.setWorkspaceBusy(
        resolveSetStateAction(workspaceStore.workspaceBusy, action)
      ),
    setSessionStoreReady: (action: SetStateAction<boolean>) =>
      sessionStore.setSessionStoreReady(
        resolveSetStateAction(sessionStore.sessionStoreReady, action)
      ),
    setRagDocs: (action: SetStateAction<IngestionStatus[]>) =>
      chatModeStore.setRagDocs(resolveSetStateAction(chatModeStore.ragDocs, action)),
    setSessions: (action: SetStateAction<ChatSession[]>) =>
      sessionStore.setSessions(resolveSetStateAction(sessionStore.sessions, action)),
    setOpenSessionIds: (action: SetStateAction<string[]>) =>
      sessionStore.setOpenSessionIds(
        resolveSetStateAction(sessionStore.openSessionIds, action)
      ),
    setActiveSessionId: (action: SetStateAction<string>) =>
      sessionStore.setActiveSessionId(
        resolveSetStateAction(sessionStore.activeSessionId, action)
      ),
    setMindmapsBySession: (action: SetStateAction<Record<string, MindMapGraph[]>>) =>
      chatModeStore.setMindmapsBySession(
        resolveSetStateAction(chatModeStore.mindmapsBySession, action)
      ),
    setActiveMindmapOverlay: (action: SetStateAction<MindmapOverlayState | null>) =>
      chatModeStore.setActiveMindmapOverlay(
        resolveSetStateAction(chatModeStore.activeMindmapOverlay, action)
      ),
    setActiveWorkspace: (action: SetStateAction<WorkspaceRecord | null>) =>
      workspaceStore.setActiveWorkspace(
        resolveSetStateAction(workspaceStore.activeWorkspace, action)
      ),
    setWorkspaceScope: (action: SetStateAction<string | null>) =>
      workspaceStore.setWorkspaceScope(
        resolveSetStateAction(workspaceStore.workspaceScope, action)
      ),
    setStartupContinueWorkspace: (action: SetStateAction<WorkspaceRecord | null>) =>
      workspaceStore.setStartupContinueWorkspace(
        resolveSetStateAction(workspaceStore.startupContinueWorkspace, action)
      ),
    refreshWorkspaceRegistry,
    refreshWorkspaceListOnly,
    loadRagDocs,
  };
}

export async function loadRagDocs(): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  await loadRagDocsAction({
    setRagDocs: (action) =>
      chatModeStore.setRagDocs(resolveSetStateAction(chatModeStore.ragDocs, action))
  });
}

export async function refreshWorkspaceRegistry(): Promise<void> {
  const workspaceStore = useWorkspaceStore.getState();
  await refreshWorkspaceRegistryAction({
    setWorkspaces: (action) =>
      workspaceStore.setWorkspaces(resolveSetStateAction(workspaceStore.workspaces, action)),
    setActiveWorkspace: (action) =>
      workspaceStore.setActiveWorkspace(resolveSetStateAction(workspaceStore.activeWorkspace, action))
  });
}

export async function refreshWorkspaceListOnly(): Promise<void> {
  const workspaceStore = useWorkspaceStore.getState();
  await refreshWorkspaceListOnlyAction({
    setWorkspaces: (action) =>
      workspaceStore.setWorkspaces(resolveSetStateAction(workspaceStore.workspaces, action))
  });
}

export async function switchWorkspaceById(workspaceId: string): Promise<void> {
  const ctx = getWorkspaceMutationContext();
  await switchWorkspaceByIdAction(workspaceId, ctx);
}

export async function createNewWorkspace(): Promise<void> {
  const ctx = getWorkspaceMutationContext();
  await createNewWorkspaceAction(ctx);
}

export async function saveWorkspaceFile(): Promise<void> {
  const sessionStore = useSessionStore.getState();
  const workspaceStore = useWorkspaceStore.getState();
  const activeSession = sessionStore.getActiveSession();
  
  await saveWorkspaceFileAction({
    workspaceBusy: workspaceStore.workspaceBusy,
    activeSession,
    activeWorkspace: workspaceStore.activeWorkspace,
    sessions: sessionStore.sessions,
    activeSessionId: sessionStore.activeSessionId,
    buildWorkspaceFrontendState: (safeActive: string) => buildWorkspaceFrontendState(safeActive),
    setWorkspaceBusy: (action) =>
      workspaceStore.setWorkspaceBusy(resolveSetStateAction(workspaceStore.workspaceBusy, action)),
    setActiveWorkspace: (action) =>
      workspaceStore.setActiveWorkspace(resolveSetStateAction(workspaceStore.activeWorkspace, action)),
    refreshWorkspaceRegistry,
    saveWorkspaceAsFile
  });
}

export async function saveWorkspaceAsFile(): Promise<void> {
  const sessionStore = useSessionStore.getState();
  const workspaceStore = useWorkspaceStore.getState();
  const activeSession = sessionStore.getActiveSession();
  
  await saveWorkspaceAsFileAction({
    workspaceBusy: workspaceStore.workspaceBusy,
    activeSession,
    activeWorkspace: workspaceStore.activeWorkspace,
    sessions: sessionStore.sessions,
    activeSessionId: sessionStore.activeSessionId,
    buildWorkspaceFrontendState: (safeActive: string) => buildWorkspaceFrontendState(safeActive),
    setWorkspaceBusy: (action) =>
      workspaceStore.setWorkspaceBusy(resolveSetStateAction(workspaceStore.workspaceBusy, action)),
    setActiveWorkspace: (action) =>
      workspaceStore.setActiveWorkspace(resolveSetStateAction(workspaceStore.activeWorkspace, action)),
    refreshWorkspaceRegistry
  });
}

export async function openWorkspaceFromFile(): Promise<void> {
  const ctx = getWorkspaceMutationContext();
  await openWorkspaceFromFileAction(ctx);
}

export async function renameWorkspaceById(workspaceId: string, newName: string): Promise<void> {
  const workspaceStore = useWorkspaceStore.getState();
  await renameWorkspaceByIdAction(workspaceId, newName, {
    workspaceBusy: workspaceStore.workspaceBusy,
    activeWorkspace: workspaceStore.activeWorkspace,
    setWorkspaceBusy: (action) =>
      workspaceStore.setWorkspaceBusy(resolveSetStateAction(workspaceStore.workspaceBusy, action)),
    refreshWorkspaceRegistry,
    refreshWorkspaceListOnly
  });
}

export async function deleteWorkspaceById(workspaceId: string): Promise<void> {
  const ctx = getWorkspaceMutationContext();
  await deleteWorkspaceByIdAction(workspaceId, ctx);
}

export function buildWorkspaceFrontendState(safeActive: string): string {
  const sessionStore = useSessionStore.getState();
  const chatModeStore = useChatModeStore.getState();
  const modelStore = useModelStore.getState();
  
  return JSON.stringify({
    sessions: sessionStore.sessions.map(sessionForPersistence),
    activeSessionId: safeActive,
    openSessionIds: sessionStore.openSessionIds,
    mindmapsBySession: chatModeStore.mindmapsBySession,
    selectedModel: modelStore.selectedModel,
    selectedTtsEngine: modelStore.selectedTtsEngine,
    selectedVisionModel: modelStore.selectedVisionModel,
  });
}